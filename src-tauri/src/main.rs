#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use portstead_core::{
    broker,
    credentials::{self, Credentials},
    engine::Engine,
    kubernetes::{self, KubeImport},
    model::{Library, Target},
    operations::Operation,
    rdp::{self, RdpInput},
    session::{Input, Size, Update},
    store::Store,
};
use std::{path::Path, sync::Arc};
use tauri::State;

type Reply<T> = Result<T, String>;
fn reply<T>(value: anyhow::Result<T>) -> Reply<T> {
    value.map_err(|e| format!("{e:#}"))
}

#[tauri::command]
fn load_library(engine: State<Arc<Engine>>) -> Reply<Library> {
    reply(engine.store.load())
}
#[tauri::command]
fn save_library(engine: State<Arc<Engine>>, library: Library) -> Reply<Library> {
    let saved = reply(engine.store.save(library))?;
    for op in engine.operations.list() {
        if op.actor == "agent"
            && saved
                .connection(&op.connection_id)
                .map(|c| !c.agent_access)
                .unwrap_or(true)
        {
            let _ = engine.operations.cancel(&op.id);
        }
    }
    Ok(saved)
}
#[tauri::command]
fn import_library(path: String) -> Reply<Library> {
    reply(Store::read(Path::new(&path)))
}
#[tauri::command]
fn export_library(engine: State<Arc<Engine>>, path: String) -> Reply<()> {
    reply(engine.store.export(Path::new(&path)))
}
#[tauri::command]
fn import_kubeconfig(path: String) -> Reply<KubeImport> {
    reply(kubernetes::inspect(Path::new(&path)))
}
#[tauri::command]
fn auth_info(
    engine: State<Arc<Engine>>,
    connection_id: String,
    expected_target: Target,
) -> Reply<serde_json::Value> {
    let library = reply(engine.store.load())?;
    let connection = reply(library.checked_connection(&connection_id, &expected_target))?;
    let stored = credentials::entry(connection)
        .and_then(|e| e.get_password().map_err(anyhow::Error::from))
        .is_ok();
    let mut username = match &connection.target {
        Target::Rdp { username, .. } | Target::Winrm { username, .. } => username.clone(),
        _ => String::new(),
    };
    let mut stored = stored;
    if let Target::Rdp {
        host,
        domain,
        username: configured,
        ..
    } = &connection.target
    {
        if let Some((name, _)) = credentials::saved_rdp_for(host, configured, domain) {
            stored = true;
            if username.is_empty() {
                username = name;
            }
        }
    }
    Ok(serde_json::json!({"stored":stored,"username":username}))
}
#[tauri::command]
fn forget_credential(engine: State<Arc<Engine>>, connection_id: String) -> Reply<()> {
    reply(
        engine
            .store
            .load()
            .and_then(|library| credentials::forget(library.connection(&connection_id)?)),
    )
}
#[tauri::command]
fn open_session(
    engine: State<Arc<Engine>>,
    connection_id: String,
    expected_target: Target,
    entry: String,
    credentials: Credentials,
    size: Size,
) -> Reply<String> {
    reply(engine.store.load().and_then(|library| {
        engine.sessions.open(
            library
                .checked_connection(&connection_id, &expected_target)?
                .clone(),
            entry,
            credentials,
            size,
        )
    }))
}
#[tauri::command]
fn session_poll(engine: State<Arc<Engine>>, id: String) -> Reply<Update> {
    reply(engine.sessions.poll(&id))
}
#[tauri::command]
fn session_write(engine: State<Arc<Engine>>, id: String, data: Vec<u8>) -> Reply<()> {
    reply(engine.sessions.write(&id, data))
}
#[tauri::command]
fn session_resize(engine: State<Arc<Engine>>, id: String, size: Size) -> Reply<()> {
    reply(engine.sessions.resize(&id, size))
}
#[tauri::command]
fn session_close(engine: State<Arc<Engine>>, id: String) -> Reply<()> {
    reply(engine.sessions.close(&id))
}
#[tauri::command]
fn desktop_frame(
    engine: State<Arc<Engine>>,
    id: String,
    sequence: u64,
) -> Reply<tauri::ipc::Response> {
    let session = reply(engine.sessions.get(&id))?;
    let frame = session.frame.lock().unwrap();
    Ok(tauri::ipc::Response::new(
        frame
            .as_ref()
            .filter(|f| f.sequence > sequence)
            .map(|f| f.bytes())
            .unwrap_or_default(),
    ))
}
#[tauri::command]
fn desktop_input(engine: State<Arc<Engine>>, id: String, input: RdpInput) -> Reply<()> {
    let session = reply(engine.sessions.get(&id))?;
    if let Input::Rdp(sender) = &session.input {
        sender
            .try_send(input)
            .map_err(|_| "Desktop input queue is busy; try again".into())
    } else {
        Err("Not a remote desktop session".into())
    }
}
#[tauri::command]
async fn rdp_probe(engine: State<'_, Arc<Engine>>, connection_id: String) -> Reply<rdp::Probe> {
    let connection = reply(
        engine
            .store
            .load()
            .and_then(|library| Ok(library.connection(&connection_id)?.clone())),
    )?;
    let Target::Rdp { host, port, .. } = connection.target else {
        return Err("Not an RDP connection".into());
    };
    tokio::task::spawn_blocking(move || rdp::probe(&host, port))
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
async fn run_command(
    engine: State<'_, Arc<Engine>>,
    connection_id: String,
    expected_target: Target,
    command: String,
    credentials: Credentials,
) -> Reply<String> {
    reply(engine.store.load().and_then(|library| {
        engine.operations.start(
            library
                .checked_connection(&connection_id, &expected_target)?
                .clone(),
            command,
            60,
            credentials,
            false,
        )
    }))
}
#[tauri::command]
fn operations_list(engine: State<Arc<Engine>>) -> Vec<Operation> {
    engine.operations.list()
}
#[tauri::command]
fn operation_cancel(engine: State<Arc<Engine>>, id: String) -> Reply<()> {
    reply(engine.operations.cancel(&id))
}
#[tauri::command]
async fn enable_agents(engine: State<'_, Arc<Engine>>) -> Reply<serde_json::Value> {
    let port = reply(broker::start(engine.inner().clone()).await)?;
    Ok(
        serde_json::json!({"port":port,"executable":std::env::current_exe().map_err(|e|e.to_string())?.to_string_lossy(),"profile_directory":engine.store.directory.to_string_lossy()}),
    )
}
#[tauri::command]
fn disable_agents(engine: State<Arc<Engine>>) {
    engine.stop_agents();
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}

fn run() -> anyhow::Result<()> {
    let args: Vec<_> = std::env::args().collect();
    let store = Store::default_location()?;
    if args.get(1).map(String::as_str) == Some("--mcp") {
        return tokio::runtime::Runtime::new()?
            .block_on(portstead_core::mcp::serve(broker::Client::new(&store)?));
    }
    if args.get(1).map(String::as_str) == Some("--rdp-probe") {
        let host = args
            .get(2)
            .ok_or_else(|| anyhow::anyhow!("Provide the test host"))?;
        anyhow::ensure!(portstead_core::model::valid_host(host), "Invalid host");
        println!("{}", serde_json::to_string_pretty(&rdp::probe(host, 3389))?);
        return Ok(());
    }
    let engine = Engine::new(store);
    if args.get(1).map(String::as_str) == Some("--serve-agents") {
        return tokio::runtime::Runtime::new()?.block_on(async {
            broker::start(engine.clone()).await?;
            eprintln!("Local agent engine is running");
            tokio::signal::ctrl_c().await?;
            engine.shutdown();
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            Ok(())
        });
    }
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(engine.clone())
        .invoke_handler(tauri::generate_handler![
            load_library,
            save_library,
            import_library,
            export_library,
            import_kubeconfig,
            auth_info,
            forget_credential,
            open_session,
            session_poll,
            session_write,
            session_resize,
            session_close,
            desktop_frame,
            desktop_input,
            rdp_probe,
            run_command,
            operations_list,
            operation_cancel,
            enable_agents,
            disable_agents
        ])
        .build(tauri::generate_context!())?;
    app.run(move |_, event| {
        if let tauri::RunEvent::Exit = event {
            engine.shutdown();
        }
    });
    Ok(())
}
