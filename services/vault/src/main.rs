// OutLayer entry: JSON in on stdin, `{ success, output, error }` out on stdout.

mod vault;

#[cfg(target_os = "wasi")]
mod outlayer_store {
    use outlayer::storage;

    /// The project's worker storage, encrypted by OutLayer's keystore and readable by no other project.
    pub struct Worker;

    impl super::vault::Store for Worker {
        fn get(&self, key: &str) -> Result<Option<Vec<u8>>, String> {
            storage::get_worker(key).map_err(|e| e.to_string())
        }
        fn put_new(&mut self, key: &str, value: &[u8]) -> Result<bool, String> {
            if storage::get_worker(key).map_err(|e| e.to_string())?.is_some() {
                return Ok(false);
            }
            storage::set_worker(key, value).map_err(|e| e.to_string())?;
            Ok(true)
        }
    }
}

#[cfg(target_os = "wasi")]
fn main() {
    use outlayer::env;

    let out = match env::input_json::<vault::Input>() {
        Ok(Some(input)) => {
            let caller = env::signer_account_id();
            let owner = std::env::var("OUTLAYER_PROJECT_OWNER").ok().filter(|s| !s.is_empty());
            vault::handle(input, caller.as_deref(), owner.as_deref(), &mut outlayer_store::Worker)
        }
        _ => vault::Output { success: false, output: serde_json::Value::Null, error: Some("bad input".into()) },
    };
    let _ = env::output_json(&out);
}

#[cfg(not(target_os = "wasi"))]
fn main() {
    eprintln!("maskwars-vault runs on OutLayer: build with --target wasm32-wasip2");
    std::process::exit(1);
}
