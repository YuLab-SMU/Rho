;; Minimal no-import Guest ABI V2 plugin.
;;
;; The host envelope begins with:
;;   {"call_id":"call.<16 hex digits>","request":...}
;;
;; `rho_begin` copies that actual 21-byte call ID into its terminal response.
;; A hard-coded test call ID would pass a private fixture but fail under Rho's
;; ordinary host call-ID source.
(module
  (memory (export "memory") 1 32)

  (data (i32.const 4096) "{\22type\22:\22complete\22,\22call_id\22:\22")
  (data (i32.const 4147) "\22,\22result\22:{\22kind\22:\22notification\22,\22message\22:\22Rho local plugin is running\22}}")

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

  (func (export "rho_heartbeat") (result i32)
    i32.const 0)

  (func (export "rho_quiesce") (result i32)
    i32.const 0)

  (func (export "rho_dispose") (result i32)
    i32.const 0)

  (func (export "rho_begin") (param $ptr i32) (param $len i32) (result i64)
    ;; The host call ID starts at byte 12 and is always 21 bytes.
    ;; Copy it with core loads/stores because the accepted host disables the
    ;; bulk-memory proposal.
    i32.const 4126
    local.get $ptr
    i32.const 12
    i32.add
    i64.load
    i64.store

    i32.const 4134
    local.get $ptr
    i32.const 20
    i32.add
    i64.load
    i64.store

    i32.const 4142
    local.get $ptr
    i32.const 28
    i32.add
    i32.load
    i32.store

    i32.const 4146
    local.get $ptr
    i32.const 32
    i32.add
    i32.load8_u
    i32.store8

    ;; Pack pointer 4096 and byte length 126 into one i64.
    i64.const 17592186044542)

  (func (export "rho_resume") (param i32 i32) (result i64)
    i64.const 0)

  (func (export "rho_cancel") (param i32 i32) (result i32)
    i32.const 0))
