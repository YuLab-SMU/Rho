fn main() -> Result<(), Box<dyn std::error::Error>> {
    let output = std::env::args_os()
        .nth(1)
        .ok_or("Expected manifest output path")?;
    let manifest = rho_agent_backend::manifest::manifest();
    manifest.validate()?;
    std::fs::write(output, serde_json::to_string_pretty(&manifest)? + "\n")?;
    Ok(())
}
