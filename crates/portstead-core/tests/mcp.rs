use portstead_core::{broker, engine::Engine, mcp::Server, store::Store};
use rmcp::ServiceExt;
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, ReadHalf, WriteHalf};

struct Cleanup(Arc<Engine>);
impl Drop for Cleanup {
    fn drop(&mut self) {
        self.0.shutdown();
    }
}

async fn request(
    reader: &mut BufReader<ReadHalf<DuplexStream>>,
    writer: &mut WriteHalf<DuplexStream>,
    id: u64,
    method: &str,
    params: Value,
) -> Value {
    writer
        .write_all(
            format!(
                "{}\n",
                json!({"jsonrpc":"2.0","id":id,"method":method,"params":params})
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    let mut line = String::new();
    tokio::time::timeout(Duration::from_secs(10), reader.read_line(&mut line))
        .await
        .unwrap()
        .unwrap();
    let response: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(response["id"], id);
    assert!(response.get("error").is_none(), "{response}");
    response["result"].clone()
}

fn tool_value(result: &Value) -> Value {
    assert_ne!(result["isError"], true, "{result}");
    serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap()
}

#[tokio::test]
#[ignore = "requires a working, unlocked operating-system credential store"]
async fn mcp_negotiates_executes_and_revokes_through_real_local_bridge() {
    let directory = tempfile::tempdir().unwrap();
    let engine = Engine::new(Store {
        directory: directory.path().into(),
    });
    let _cleanup = Cleanup(engine.clone());
    let port = broker::start(engine.clone()).await.unwrap();
    let response = reqwest::Client::new()
        .post(format!("http://127.0.0.1:{port}/agent"))
        .json(&json!({"method":"connections_list"}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::UNAUTHORIZED);
    let (client_transport, server_transport) = tokio::io::duplex(65536);
    let server = Server::new(broker::Client::new(&engine.store).unwrap());
    let server_task = tokio::spawn(async move {
        server
            .serve(server_transport)
            .await
            .unwrap()
            .waiting()
            .await
            .unwrap();
    });
    let (reader, mut writer) = tokio::io::split(client_transport);
    let mut reader = BufReader::new(reader);
    let initialized = request(&mut reader, &mut writer, 1, "initialize", json!({"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"portstead-integration-test","version":"1"}})).await;
    assert!(initialized["capabilities"]["tools"].is_object());
    assert_eq!(initialized["serverInfo"]["name"], "portstead");
    writer
        .write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n")
        .await
        .unwrap();
    let tools = request(&mut reader, &mut writer, 2, "tools/list", json!({})).await;
    assert_eq!(tools["tools"].as_array().unwrap().len(), 6);
    let catalog = tool_value(
        &request(
            &mut reader,
            &mut writer,
            3,
            "tools/call",
            json!({"name":"connections_list","arguments":{}}),
        )
        .await,
    );
    assert_eq!(catalog["connections"], json!([]));
    let mut library = engine.store.load().unwrap();
    library.connections[0].agent_access = true;
    engine.store.save(library).unwrap();
    let catalog = tool_value(
        &request(
            &mut reader,
            &mut writer,
            4,
            "tools/call",
            json!({"name":"connections_list","arguments":{}}),
        )
        .await,
    );
    let operation = tool_value(&request(&mut reader, &mut writer, 5, "tools/call", json!({"name":"command_run","arguments":{"connection_id":"local","library_revision":catalog["library_revision"],"command":"echo portstead-mcp-check"}})).await);
    let mut finished = false;
    for id in 6..106 {
        let result = tool_value(&request(&mut reader, &mut writer, id, "tools/call", json!({"name":"operation_read","arguments":{"operation_id":operation["operation_id"]}})).await);
        if result["status"] != "running" {
            assert_eq!(result["exit_code"], 0);
            assert!(result["stdout"]
                .as_str()
                .unwrap()
                .contains("portstead-mcp-check"));
            finished = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(finished, "MCP operation did not finish");
    let mut library = engine.store.load().unwrap();
    library.connections[0].agent_access = false;
    engine.store.save(library).unwrap();
    let revoked = request(
        &mut reader,
        &mut writer,
        107,
        "tools/call",
        json!({"name":"operation_read","arguments":{"operation_id":operation["operation_id"]}}),
    )
    .await;
    assert_eq!(revoked["isError"], true);
    drop(writer);
    drop(reader);
    tokio::time::timeout(Duration::from_secs(5), server_task)
        .await
        .unwrap()
        .unwrap();
    engine.shutdown();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(broker::Client::new(&engine.store).is_err());
}
