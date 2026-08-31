fn main() {
    let profile = rho_sandbox::platform::PlatformSandboxProfile::detect();
    println!("{}", serde_json::to_string_pretty(&profile).unwrap());
}
