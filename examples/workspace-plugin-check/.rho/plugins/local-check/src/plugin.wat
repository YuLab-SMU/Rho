;; Zero-permission Manifest V3 Check rule fixture. The guest returns one typed
;; informational finding. The host owns snapshot admission and exact origin.
(module
  (memory (export "memory") 1 32)

  (data (i32.const 8400) "{\22type\22:\22complete\22,\22call_id\22:\22")
  (data (i32.const 8500) "\22,\22result\22:{\22contract\22:\22rho.ui.check-rule-pack.output.v1\22,\22findings\22:[{\22rule_id\22:\22check.rule.local.structure\22,\22rule_version\22:1,\22severity\22:\22info\22,\22category\22:\22project structure\22,\22title\22:\22Local structure rule ran\22,\22summary\22:\22The local workspace rule pack reviewed the immutable project descriptor.\22,\22remediation\22:\22Review this informational fixture before replacing it with project rules.\22,\22evidence\22:[{\22kind\22:\22note\22,\22text\22:\22Zero-permission example rule pack\22}],\22limitations\22:[]}],\22limitations\22:[]}}")

  (func $copy (param $destination i32) (param $source i32) (param $count i32)
    (local $index i32)
    (block $done
      (loop $next
        local.get $index
        local.get $count
        i32.ge_u
        br_if $done
        local.get $destination
        local.get $index
        i32.add
        local.get $source
        local.get $index
        i32.add
        i32.load8_u
        i32.store8
        local.get $index
        i32.const 1
        i32.add
        local.set $index
        br $next)))

  (func (export "rho_activate") (param $abi i32) (result i32)
    local.get $abi
    i32.const 2
    i32.ne)
  (func (export "rho_echo") (param $ptr i32) (param $len i32) (result i64)
    local.get $ptr
    i64.extend_i32_u
    i64.const 32
    i64.shl
    local.get $len
    i64.extend_i32_u
    i64.or)
  (func (export "rho_heartbeat") (result i32) i32.const 0)
  (func (export "rho_quiesce") (result i32) i32.const 0)
  (func (export "rho_dispose") (result i32) i32.const 0)

  (func (export "rho_begin") (param $ptr i32) (param $len i32) (result i64)
    i32.const 4096
    i32.const 8400
    i32.const 30
    call $copy
    i32.const 4126
    local.get $ptr
    i32.const 12
    i32.add
    i32.const 21
    call $copy
    i32.const 4147
    i32.const 8500
    i32.const 495
    call $copy
    i64.const 17592186044416
    i64.const 546
    i64.or)

  (func (export "rho_resume") (param i32 i32) (result i64) i64.const 0)
  (func (export "rho_cancel") (param i32 i32) (result i32) i32.const 0))
