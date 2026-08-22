;; Multi-instance, zero-permission Manifest V3 Surface fixture.
;; Every render or event returns the same bounded declarative document. The
;; host still supplies and checks the exact project/plugin/digest/generation,
;; Surface instance, placement revision, and call ID route.
(module
  (memory (export "memory") 1 32)

  (data (i32.const 8400) "{\22type\22:\22complete\22,\22call_id\22:\22")
  (data (i32.const 8500) "\22,\22result\22:{\22contract\22:\22rho.plugin_surface_document.v1\22,\22revision\22:1,\22title\22:\22Local surface\22,\22blocks\22:[{\22kind\22:\22column\22,\22blocks\22:[{\22kind\22:\22text\22,\22text\22:\22Independent plugin Surface instance\22},{\22kind\22:\22field\22,\22control_id\22:\22note\22,\22label\22:\22Instance note\22,\22value\22:\22\22,\22placeholder\22:\22Each instance owns its own view state\22,\22disabled\22:false,\22busy\22:false},{\22kind\22:\22command_button\22,\22control_id\22:\22refresh\22,\22label\22:\22Refresh\22,\22command_id\22:\22refresh\22,\22disabled\22:false,\22busy\22:false}]}]}}")

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
    ;; {"type":"complete","call_id":"
    i32.const 4096
    i32.const 8400
    i32.const 30
    call $copy

    ;; The host envelope starts with {"call_id":"call.<16 hex digits>".
    i32.const 4126
    local.get $ptr
    i32.const 12
    i32.add
    i32.const 21
    call $copy

    i32.const 4147
    i32.const 8500
    i32.const 471
    call $copy

    ;; Pointer 4096 and total byte length 522.
    i64.const 17592186044416
    i64.const 522
    i64.or)

  (func (export "rho_resume") (param i32 i32) (result i64) i64.const 0)
  (func (export "rho_cancel") (param i32 i32) (result i32) i32.const 0))
