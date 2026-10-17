use crate::*;
use claakecode_core::{ChatMessage, ProviderRequest, StreamEvent};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::{sync::atomic::{AtomicBool, AtomicU64, Ordering}, time::Instant};

const SUITE_VERSION: &str = "benchmark-v1";
const SYSTEM: &str = "Complete the fixed benchmark task. Do not use tools. Return a concise answer.";
const CASES: &[(&str, &str)] = &[
    ("reasoning", "A box has 3 red and 2 blue balls. What is the probability of drawing two red balls without replacement? Give the exact fraction."),
    ("code", "Write a Rust function `is_even(n: i64) -> bool` and include two assertions covering even and odd values."),
    ("verification", "Sort [7, 2, 5, 2] in ascending order and return only the resulting list."),
];
const MAX_REPETITIONS: u32 = 10;
const MAX_OUTPUT: u32 = 4096;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all="camelCase")]
pub(super) struct StartBenchmarkInput {
    pub provider_id: String,
    pub model_id: String,
    pub budget_usd: f64,
    pub max_output_tokens: u32,
    pub repetitions: u32,
    pub confirmed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
pub(super) struct BenchmarkRun {
    pub run_id: String,
    pub provider: String,
    pub model: String,
    pub suite_version: String,
    pub started_at_ms: i64,
    pub finished_at_ms: Option<i64>,
    pub status: String,
    pub completed_cases: u32,
    pub total_cases: u32,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub estimated_cost: f64,
    pub median_ttft_ms: Option<f64>,
    pub median_output_tokens_per_second: Option<f64>,
    pub verified_checks: u32,
    pub error: Option<String>,
}

#[derive(Clone)]
struct RunControl(Arc<AtomicBool>);

#[tauri::command]
pub(super) async fn start_active_benchmark(app: AppHandle, state: State<'_, DesktopState>, input: StartBenchmarkInput) -> Result<String, String> {
    if !input.confirmed { return Err("explicit confirmation is required".into()); }
    if !input.budget_usd.is_finite() || input.budget_usd <= 0.0 { return Err("a positive finite USD budget is required".into()); }
    if input.repetitions == 0 || input.repetitions > MAX_REPETITIONS { return Err("repetitions must be between 1 and 10".into()); }
    if input.max_output_tokens == 0 || input.max_output_tokens > MAX_OUTPUT { return Err("maxOutputTokens must be between 1 and 4096".into()); }
    let provider = provider_from_registry(&state, &input.provider_id)?;
    let model = ModelRef::new(&input.provider_id, &input.model_id);
    let prices = state.store.model_prices().map_err(error_to_string)?;
    let price = prices.into_iter().find(|p| p.provider == input.provider_id && p.model == input.model_id).ok_or("benchmark blocked: configure a price for this model first")?;
    if ![price.input, price.output, price.cache_read, price.cache_creation].iter().all(|v| v.is_finite() && *v >= 0.0) { return Err("configured model prices are invalid".into()); }
    let worst_case = (CASES.len() * input.repetitions as usize) as f64 * (input.max_output_tokens as f64 * price.output / 1_000_000.0 + 1000.0 * price.input / 1_000_000.0);
    if worst_case > input.budget_usd { return Err(format!("budget too small: conservative reservation is ${worst_case:.6}")); }
    let id = format!("{}-{}", now_ms(), NEXT_RUN_ID.fetch_add(1, Ordering::Relaxed));
    let started = now_ms();
    let mut run = BenchmarkRun { run_id:id.clone(), provider:input.provider_id.clone(), model:input.model_id.clone(), suite_version:SUITE_VERSION.into(), started_at_ms:started, finished_at_ms:None, status:"running".into(), completed_cases:0, total_cases:(CASES.len() as u32)*input.repetitions, input_tokens:0, output_tokens:0, estimated_cost:0.0, median_ttft_ms:None, median_output_tokens_per_second:None, verified_checks:0, error:None };
    persist_run(&state.store, &run)?;
    let cancel = RunControl(Arc::new(AtomicBool::new(false)));
    RUNS.get_or_init(||StdMutex::new(HashMap::new())).lock().map_err(|_| "benchmark runtime unavailable")?.insert(id.clone(), cancel.clone());
    let store=state.store.clone(); let app2=app.clone(); let run_id=id.clone();
    tauri::async_runtime::spawn(async move {
        let mut ttfts=Vec::new(); let mut speeds=Vec::new();
        'cases: for rep in 0..input.repetitions {
            for (case_id,prompt) in CASES {
                if cancel.0.load(Ordering::Relaxed) { run.status="stopped".into(); break 'cases; }
                // Conservative per-request reservation is checked immediately before each provider request.
                let reserve=input.max_output_tokens as f64*price.output/1_000_000.0+1000.0*price.input/1_000_000.0;
                if run.estimated_cost+reserve > input.budget_usd { run.status="budget_exhausted".into(); break 'cases; }
                let request=ProviderRequest::new(model.clone(), vec![ChatMessage::user_text((*prompt).to_string())]).with_system(SYSTEM); let mut request=request; request.max_output_tokens=Some(input.max_output_tokens);
                let estimate=match provider.estimate_tokens(request.clone()).await { Ok(v)=>v, Err(e)=>{run.status="error".into();run.error=Some(e.to_string());break 'cases;} };
                if estimate.input_tokens > 1000 { run.status="budget_exhausted".into(); break 'cases; }
                let start=Instant::now(); let mut first=None; let mut out=String::new(); let mut tokens=0u64;
                let mut stream=match provider.stream(request).await {Ok(s)=>s,Err(e)=>{run.status="error".into();run.error=Some(e.to_string());break 'cases;}};
                loop { tokio::select! { _=async { while !cancel.0.load(Ordering::Relaxed) { tokio::time::sleep(std::time::Duration::from_millis(20)).await; } } => { drop(stream); run.status="stopped".into(); break 'cases; }, event=stream.next()=> match event { Some(Ok(StreamEvent::TextDelta{delta,..}))=>{first.get_or_insert(start.elapsed().as_millis() as u64); tokens+=delta.split_whitespace().count() as u64; out.push_str(&delta);}, Some(Ok(StreamEvent::MessageStop{usage,..}))=>{tokens=u64::from(usage.output_tokens); run.input_tokens+=u64::from(usage.input_tokens); run.output_tokens+=tokens;}, Some(Ok(_))=>{}, Some(Err(e))=>{run.status="partial_error".into();run.error=Some(e.to_string());break 'cases;}, None=>break } } }
                let elapsed=start.elapsed().as_secs_f64(); if let Some(t)=first {ttfts.push(t as f64)} if elapsed>0.0 {speeds.push(tokens as f64/elapsed)}
                run.estimated_cost+=(estimate.input_tokens as f64*price.input+tokens as f64*price.output as f64)/1_000_000.0;
                run.verified_checks+=verify_case(case_id,&out) as u32; run.completed_cases+=1;
                let _=app2.emit("active-benchmark-progress",json!({"runId":run_id,"caseId":case_id,"repetition":rep+1,"completed":run.completed_cases,"total":run.total_cases,"status":run.status,"estimatedCostUsd":run.estimated_cost}));
                if run.status=="running" {let _=persist_run(&store,&run);}
            }
        }
        if run.status=="running" {run.status="completed".into();}
        run.median_ttft_ms=median(&mut ttfts); run.median_output_tokens_per_second=median(&mut speeds); run.finished_at_ms=Some(now_ms()); let _=persist_run(&store,&run);
        if let Ok(mut active)=RUNS.get_or_init(||StdMutex::new(HashMap::new())).lock(){active.remove(&run_id);}
    });
    Ok(id)
}

fn verify_case(id:&str, output:&str)->bool { match id { "reasoning"=>output.contains("1/5"), "code"=>output.contains("is_even")&&output.contains("assert"), "verification"=>output.contains("[2, 2, 5, 7]"), _=>false } }
fn median(values: &mut [f64]) -> Option<f64> { if values.is_empty() { return None; } values.sort_by(f64::total_cmp); let mid=values.len()/2; Some(if values.len()%2==0 {(values[mid-1]+values[mid])/2.0} else {values[mid]}) }
static NEXT_RUN_ID: AtomicU64 = AtomicU64::new(1);
fn now_ms()->i64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as i64 }
fn persist_run(store:&AppStore, run:&BenchmarkRun)->Result<(),String>{ let mut all:Vec<BenchmarkRun>=store.load_json_setting("active_benchmark_runs").map_err(error_to_string)?.unwrap_or_default(); if let Some(r)=all.iter_mut().find(|r|r.run_id==run.run_id){*r=run.clone()}else{all.insert(0,run.clone())}; all.truncate(100); store.save_json_setting("active_benchmark_runs",&all).map_err(error_to_string) }
static RUNS: std::sync::OnceLock<StdMutex<HashMap<String,RunControl>>>=std::sync::OnceLock::new();
fn runs()-> &'static StdMutex<HashMap<String,RunControl>> {RUNS.get_or_init(||StdMutex::new(HashMap::new()))}
#[tauri::command]
pub(super) fn stop_active_benchmark(run_id:String)->Result<(),String>{let active=runs().lock().map_err(error_to_string)?;let c=active.get(&run_id).ok_or("benchmark is not active")?;c.0.store(true,Ordering::Relaxed);Ok(())}
#[tauri::command]
pub(super) fn get_active_benchmark_runs(state:State<'_,DesktopState>)->Result<Vec<BenchmarkRun>,String>{state.store.load_json_setting("active_benchmark_runs").map_err(error_to_string).map(|v|v.unwrap_or_default())}
