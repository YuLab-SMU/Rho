fn main() -> Result<(), Box<dyn std::error::Error>> {
    let destination = std::env::args_os()
        .nth(1)
        .ok_or("Expected manifest destination")?;
    let manifest = rho_process_backend::manifest::manifest();
    manifest.validate()?;
    std::fs::write(destination, serde_json::to_string_pretty(&manifest)? + "\n")?;
    Ok(())
}
