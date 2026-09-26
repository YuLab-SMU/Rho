fn main() -> Result<(), Box<dyn std::error::Error>> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let result = runtime.block_on(async {
        let connection = rho_plugin_sdk::accept_stdio()
            .await
            .map_err(|error| error.to_string())?;
        rho_process_backend::server::serve(connection).await
    });
    runtime.shutdown_background();
    result.map_err(Into::into)
}
