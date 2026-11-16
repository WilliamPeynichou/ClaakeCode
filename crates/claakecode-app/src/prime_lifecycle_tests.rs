use super::*;
use tokio::net::UnixListener;

async fn reply(writer: &mut tokio::net::unix::OwnedWriteHalf, value: Value) {
    writer.write_all(format!("{value}\n").as_bytes()).await.unwrap();
}
async fn command(reader: &mut BufReader<tokio::net::unix::OwnedReadHalf>) -> Value {
    let mut line = String::new();
    reader.read_line(&mut line).await.unwrap();
    serde_json::from_str(&line).unwrap()
}
fn event(seq: u64, value: Value) -> Value {
    json!({"type":"session_event","activeSessionId":"s","meta":{"sequence":seq},"event":value})
}
async fn attach(reader: &mut BufReader<tokio::net::unix::OwnedReadHalf>, writer: &mut tokio::net::unix::OwnedWriteHalf) {
    let request = command(reader).await;
    assert_eq!(request["command"]["type"], "attach");
    reply(writer, json!({"type":"response","id":request["id"],"success":true,"data":{
        "replay":{"status":"complete"},"snapshot":{"lastEventSequence":0,
        "lastEventCursor":{"generation":"g","sequence":0},"state":{"isStreaming":false},"messages":[]}}})).await;
}
#[tokio::test]
async fn prompt_waits_past_intermediate_agent_end() {
    let path = std::env::temp_dir().join(format!("cc-boundary-{}.sock", uuid::Uuid::new_v4()));
    let listener = UnixListener::bind(&path).unwrap();
    let server = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let (read, mut write) = socket.into_split(); let mut read = BufReader::new(read);
        attach(&mut read, &mut write).await;
        let prompt = command(&mut read).await;
        reply(&mut write, json!({"type":"response","id":prompt["id"],"success":true})).await;
        reply(&mut write, event(1,json!({"type":"agent_start"}))).await;
        reply(&mut write, event(2,json!({"type":"agent_end","messages":[{"role":"assistant","stopReason":"toolUse"}]}))).await;
        let barrier = command(&mut read).await;
        assert_eq!(barrier["command"]["type"], "wait_for_headless_completion");
        reply(&mut write, event(3,json!({"type":"agent_start"}))).await;
        reply(&mut write, event(4,json!({"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"continued"}],"stopReason":"stop"}}))).await;
        reply(&mut write, event(5,json!({"type":"agent_end","messages":[{"role":"assistant","stopReason":"stop"}]}))).await;
        reply(&mut write, json!({"type":"response","id":barrier["id"],"success":true})).await;
    });
    let mut events = Vec::new();
    run_prompt(&path,"s","hello",Duration::from_secs(2),|event| events.push(event)).await.unwrap();
    server.await.unwrap(); let _ = std::fs::remove_file(path);
    assert_eq!(events.iter().filter(|e|matches!(e,crate::AgentEvent::TurnFinished{..})).count(),1);
    assert!(events.iter().any(|e|matches!(e,crate::AgentEvent::TextChunk{delta} if delta=="continued")));
}
#[tokio::test]
async fn retained_observer_receives_a_later_background_wakeup() {
    let path = std::env::temp_dir().join(format!("cc-observe-{}.sock",uuid::Uuid::new_v4()));
    let listener = UnixListener::bind(&path).unwrap();
    let (release_tx,release_rx) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::spawn(async move {
        let (socket,_) = listener.accept().await.unwrap();
        let (read,mut write) = socket.into_split(); let mut read=BufReader::new(read);
        attach(&mut read,&mut write).await;
        for seq in [1,3] {
            reply(&mut write,event(seq,json!({"type":"agent_start"}))).await;
            reply(&mut write,event(seq+1,json!({"type":"agent_end","messages":[{"role":"assistant","stopReason":"stop"}]}))).await;
            let barrier=command(&mut read).await;
            assert_eq!(barrier["command"]["type"],"wait_for_headless_completion");
            reply(&mut write,json!({"type":"response","id":barrier["id"],"success":true})).await;
        }
        let _=release_rx.await;
    });
    let (ready_tx,ready_rx)=tokio::sync::oneshot::channel();
    let (tx,mut rx)=tokio::sync::mpsc::unbounded_channel();
    let observer=tokio::spawn(async move { observe_session(&path,"s",ready_tx,|event|{let _=tx.send(event);}).await });
    ready_rx.await.unwrap();
    let mut starts=0; let mut ends=0;
    tokio::time::timeout(Duration::from_secs(3),async {
        while ends<2 { match rx.recv().await.unwrap() {
            crate::AgentEvent::TurnStarted=>starts+=1,
            crate::AgentEvent::TurnFinished{..}=>ends+=1,
            _=>{}
        }}
    }).await.unwrap();
    assert_eq!((starts,ends),(2,2));
    observer.abort(); let _=release_tx.send(());server.await.unwrap();
}
