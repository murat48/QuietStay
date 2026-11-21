//! Step 5 review: a WASM's mainnet upload fee, part by part.
//!
//! Read-only and offline: it reads WASM files and the network settings
//! evidence, and computes with the host's own fee functions. It signs and
//! sends nothing and contacts no network.
//!
//!   cargo run --release -- [--sim <evidence name>] <simulated.wasm> [<variant.wasm> ...]
//!
//! The first file must be the WASM the simulation was of: by default the
//! final rights WASM (evidence/checklist/mainnet-upload-simulation-2026-11-21.json),
//! or with `--sim mainnet-upload-simulation-web-auth-2026-11-21` the web-auth
//! WASM. Its fee must reproduce the simulated minimum resource fee exactly; if
//! it does not, the tool fails. Other files are priced the same way.
//!
//! - **Rent**: a new code entry, live for the minimum persistent TTL. Its rent
//!   size is the host's `entry_size_for_rent`: the entry's XDR size plus the
//!   parsed module's memory cost, with the network's memory cost parameters.
//!   This host counts custom sections (the interface spec included) as data
//!   segments in that cost. The code discount (÷3) is inside
//!   `compute_rent_fee`.
//! - **Everything else** (instructions, the entry write, bytes written,
//!   transaction size, history): `compute_transaction_resource_fee`.
//! - **The 15% margin**: the simulation declares 1.15 × the rent as
//!   refundable. The network charges the exact rent and refunds the rest (the
//!   testnet upload of the same WASM, 1b9ac00a…, declared 43,628,655
//!   refundable and was charged 37,920,829).

use std::path::{Path, PathBuf};

use soroban_env_host::budget::Budget;
use soroban_env_host::e2e_invoke::entry_size_for_rent;
use soroban_env_host::e2e_testutils::wasm_entry;
use soroban_env_host::fees::{
    compute_rent_fee, compute_rent_write_fee_per_1kb, compute_transaction_resource_fee,
    FeeConfiguration, LedgerEntryRentChange, RentFeeConfiguration, RentWriteFeeConfiguration,
    TransactionResources,
};
use soroban_env_host::xdr::{
    ContractCostParamEntry, ContractCostParams, ExtensionPoint, LedgerEntryData, Limits, WriteXdr,
};

fn read(p: &Path) -> serde_json::Value {
    serde_json::from_str(&std::fs::read_to_string(p).unwrap_or_else(|_| panic!("{}", p.display())))
        .unwrap()
}

fn n(v: &serde_json::Value) -> i64 {
    v.as_str()
        .map(|x| x.parse().unwrap())
        .or_else(|| v.as_i64())
        .unwrap_or_else(|| panic!("not a number: {v}"))
}

fn ceil_div(a: i64, b: i64) -> i64 {
    (a + b - 1) / b
}

fn main() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let net = "mainnet".to_string();
    let date = "2026-11-21";
    // --sim <name>: evidence/checklist/<name>.json, the simulation the first
    // WASM must reproduce (default: the rights contract's).
    let mut sim_name = format!("{net}-upload-simulation-{date}");
    if args.first().map(|a| a == "--sim").unwrap_or(false) {
        sim_name = args[1].clone();
        args.drain(..2);
    }
    assert!(!args.is_empty(), "usage: upload-fee [--sim <evidence name>] <simulated.wasm> [<variant.wasm> ...]");
    let s = read(&root.join(format!("evidence/network-settings-{net}-{date}.json")));
    let entry = |k: &str| -> serde_json::Value {
        s["updated_entry"]
            .as_array()
            .unwrap()
            .iter()
            .find_map(|e| e.get(k).cloned())
            .unwrap_or_else(|| panic!("{k} missing"))
    };
    let params = |k: &str| -> ContractCostParams {
        let v: Vec<ContractCostParamEntry> = entry(k)
            .as_array()
            .unwrap()
            .iter()
            .map(|p| ContractCostParamEntry {
                ext: ExtensionPoint::V0,
                const_term: n(&p["const_term"]),
                linear_term: n(&p["linear_term"]),
            })
            .collect();
        ContractCostParams(v.try_into().unwrap())
    };
    let budget = Budget::try_from_configs(
        u64::MAX,
        u64::MAX,
        params("contract_cost_params_cpu_instructions"),
        params("contract_cost_params_memory_bytes"),
    )
    .unwrap();
    let compute = entry("contract_compute_v0");
    let ledger = entry("contract_ledger_cost_v0");
    let ledger_ext = entry("contract_ledger_cost_ext_v0");
    let archival = entry("state_archival");
    let fee = FeeConfiguration {
        fee_per_instruction_increment: n(&compute["fee_rate_per_instructions_increment"]),
        fee_per_disk_read_entry: n(&ledger["fee_disk_read_ledger_entry"]),
        fee_per_write_entry: n(&ledger["fee_write_ledger_entry"]),
        fee_per_disk_read_1kb: n(&ledger["fee_disk_read1_kb"]),
        fee_per_write_1kb: n(&ledger_ext["fee_write1_kb"]),
        fee_per_historical_1kb: n(&entry("contract_historical_data_v0")["fee_historical1_kb"]),
        fee_per_contract_event_1kb: n(&entry("contract_events_v0")["fee_contract_events1_kb"]),
        fee_per_transaction_size_1kb: n(&entry("contract_bandwidth_v0")["fee_tx_size1_kb"]),
    };
    let state = read(&root.join(format!("evidence/checklist/soroban-state-size-{date}.json")));
    let rent_1kb = compute_rent_write_fee_per_1kb(
        n(&state[&net]["average_bytes"]),
        &RentWriteFeeConfiguration {
            state_target_size_bytes: n(&ledger["soroban_state_target_size_bytes"]),
            rent_fee_1kb_state_size_low: n(&ledger["rent_fee1_kb_soroban_state_size_low"]),
            rent_fee_1kb_state_size_high: n(&ledger["rent_fee1_kb_soroban_state_size_high"]),
            state_size_rent_fee_growth_factor: n(&ledger["soroban_state_rent_fee_growth_factor"]) as u32,
        },
    );
    let min_ttl = n(&archival["min_persistent_ttl"]) as u32;
    let rent_config = RentFeeConfiguration {
        fee_per_write_1kb: fee.fee_per_write_1kb,
        fee_per_rent_1kb: rent_1kb,
        fee_per_write_entry: fee.fee_per_write_entry,
        persistent_rent_rate_denominator: n(&archival["persistent_rent_rate_denominator"]),
        temporary_rent_rate_denominator: n(&archival["temp_rent_rate_denominator"]),
    };

    let sim = read(&root.join(format!("evidence/checklist/{sim_name}.json")));
    let sim_fee: i64 = sim["min_resource_fee_stroops"].as_str().unwrap().parse().unwrap();
    let sim_instr = sim["instructions"].as_u64().unwrap() as u32;
    let sim_write = sim["write_bytes"].as_u64().unwrap() as u32;
    let sim_unsigned = sim["transaction_size_bytes"].as_u64().unwrap() as u32;
    let sim_bytes = sim["wasm"]["bytes"].as_u64().unwrap() as usize;

    struct Priced {
        bytes: usize,
        xdr: u32,
        rent_size: u32,
        rent: i64,
        cost_inputs: String,
    }
    let price = |wasm: &[u8]| -> Priced {
        let e = wasm_entry(wasm);
        let xdr = e.to_xdr(Limits::none()).unwrap().len() as u32;
        let rent_size = entry_size_for_rent(&budget, &e, xdr).unwrap();
        let cost_inputs = match &e.data {
            LedgerEntryData::ContractCode(c) => format!("{:?}", c.ext),
            _ => unreachable!(),
        };
        let at = 1_000_000u32;
        let rent = compute_rent_fee(
            &[LedgerEntryRentChange {
                is_persistent: true,
                is_code_entry: true,
                old_size_bytes: 0,
                new_size_bytes: rent_size,
                old_live_until_ledger: 0,
                new_live_until_ledger: at + min_ttl - 1,
            }],
            &rent_config,
            at,
        );
        Priced { bytes: wasm.len(), xdr, rent_size, rent, cost_inputs }
    };
    let rest = |instructions: u32, write_bytes: u32, tx_size: u32| {
        compute_transaction_resource_fee(
            &TransactionResources {
                instructions,
                disk_read_entries: 0,
                write_entries: 1,
                disk_read_bytes: 0,
                write_bytes,
                contract_events_size_bytes: 0,
                transaction_size_bytes: tx_size,
            },
            &fee,
        )
        .0
    };
    // The simulation multiplies the refundable fee by 1.15, rounding down.
    let margin = |r: i64| r * 115 / 100;
    let xlm = |x: i64| x as f64 / 1e7;

    // The final WASM, against the simulation.
    let wasm = std::fs::read(&args[0]).unwrap();
    assert_eq!(wasm.len(), sim_bytes, "the first file must be the simulated WASM");
    let base = price(&wasm);
    assert_eq!(base.xdr, sim_write, "the entry's XDR size is the simulated write bytes");
    // The simulation prices the final envelope (Soroban data and a signature
    // added, plus its own size margin), a little larger than the unsigned one
    // recorded; find the size at which the parts add up.
    let tx_size = (sim_unsigned..sim_unsigned + 16_000)
        .find(|&t| rest(sim_instr, sim_write, t) + margin(base.rent) >= sim_fee);
    let Some(tx_size) = tx_size else {
        panic!(
            "not reproduced: rent {} (+15% = {}), rest at unsigned size {}, simulated {sim_fee}",
            base.rent,
            margin(base.rent),
            rest(sim_instr, sim_write, sim_unsigned)
        );
    };
    let non_refundable = rest(sim_instr, sim_write, tx_size);
    let total = non_refundable + margin(base.rent);
    let parts = [
        ("instructions", ceil_div(sim_instr as i64 * fee.fee_per_instruction_increment, 10_000)),
        ("entry write", fee.fee_per_write_entry),
        ("bytes written", ceil_div(sim_write as i64 * fee.fee_per_write_1kb, 1024)),
        ("transaction size", ceil_div(tx_size as i64 * fee.fee_per_transaction_size_1kb, 1024)),
        ("history", ceil_div((tx_size as i64 + 300) * fee.fee_per_historical_1kb, 1024)),
    ];
    assert_eq!(parts.iter().map(|p| p.1).sum::<i64>(), non_refundable);
    println!("{net}, offline (soroban-env-host 30.0.0 and the {date} settings); nothing signed or sent");
    println!(
        "final WASM {}: {} B; code entry XDR {} B; rent size {} B (XDR + module memory {} B)",
        args[0], base.bytes, base.xdr, base.rent_size, base.rent_size - base.xdr
    );
    println!("  cost inputs: {}", base.cost_inputs);
    println!("  rent rate {rent_1kb} stroops/KB, min persistent TTL {min_ttl} ledgers, code rent ÷3");
    for (name, v) in parts {
        println!("  {name:20} {v:>11} stroops {:>10.4} XLM  write fee, non-refundable", xlm(v));
    }
    println!("  {:20} {:>11} stroops {:>10.4} XLM  rent, refundable, charged exactly", "rent", base.rent, xlm(base.rent));
    println!(
        "  {:20} {:>11} stroops {:>10.4} XLM  declared by the simulation, refunded",
        "15% margin",
        margin(base.rent) - base.rent,
        xlm(margin(base.rent) - base.rent)
    );
    println!(
        "  = {total} stroops; simulated {sim_fee}: {} (envelope priced at {tx_size} B)",
        if total == sim_fee { "REPRODUCED EXACTLY" } else { "MISMATCH" }
    );
    println!("  charged on the network ≈ {:.4} XLM (all but the margin)", xlm(non_refundable + base.rent));
    assert_eq!(total, sim_fee, "the breakdown must reproduce the simulation");

    // Variants: the same resources, scaled to their size.
    let base_charged = non_refundable + base.rent;
    let mut rows = Vec::new();
    for p in &args[1..] {
        let w = std::fs::read(p).unwrap();
        let v = price(&w);
        let grow = |x: u32| (x as i64 + v.xdr as i64 - base.xdr as i64) as u32;
        let instr = (sim_instr as u64 * w.len() as u64 / wasm.len() as u64) as u32;
        let nr = rest(instr, v.xdr, grow(tx_size));
        let charged = nr + v.rent;
        println!(
            "{p}: {} B, rent size {} B, rent {:.4} XLM, charged ≈ {:.4} XLM (simulation would ask {:.4}), saves ≈ {:.4} XLM",
            v.bytes,
            v.rent_size,
            xlm(v.rent),
            xlm(charged),
            xlm(nr + margin(v.rent)),
            xlm(base_charged - charged)
        );
        println!("  cost inputs: {}", v.cost_inputs);
        rows.push(serde_json::json!({
            "file": p, "bytes": v.bytes, "rent_size_bytes": v.rent_size, "rent_stroops": v.rent,
            "non_refundable_stroops": nr, "charged_estimate_stroops": charged,
            "simulated_estimate_stroops": nr + margin(v.rent),
            "saving_vs_final_charged_stroops": base_charged - charged,
        }));
    }
    let out = root.join(format!("evidence/checklist/{}.json", sim_name.replace("upload-simulation", "upload-fee-breakdown")));
    let body = serde_json::json!({
        "computed_with": "tools/upload-fee (soroban-env-host 30.0.0), offline",
        "wasm_sha256": sim["wasm"]["sha256"],
        "bytes": base.bytes,
        "code_entry_xdr_bytes": base.xdr,
        "rent_size_bytes": base.rent_size,
        "module_memory_cost_bytes": base.rent_size - base.xdr,
        "rent_fee_per_1kb": rent_1kb,
        "min_persistent_ttl": min_ttl,
        "envelope_bytes_priced": tx_size,
        "write_fees_non_refundable": parts.iter().map(|(k, v)| (k.to_string(), serde_json::json!(v))).collect::<serde_json::Map<_, _>>(),
        "write_fees_total": non_refundable,
        "rent": base.rent,
        "simulation_margin_15_percent_refunded": margin(base.rent) - base.rent,
        "simulated_min_resource_fee": sim_fee,
        "reproduced_exactly": total == sim_fee,
        "charged_estimate": base_charged,
        "variants": rows,
    });
    std::fs::write(&out, serde_json::to_string_pretty(&body).unwrap() + "\n").unwrap();
    println!("wrote {}", out.display());
}
