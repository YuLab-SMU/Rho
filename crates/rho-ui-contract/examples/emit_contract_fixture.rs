fn main() {
    let fixture = rho_ui_contract::golden_contract_fixture();
    println!(
        "{}",
        serde_json::to_string_pretty(&fixture).expect("serialize RSR contract fixture")
    );
}
