;; Minimal multi-surface, no-import Guest ABI V2 component.
;;
;; The host envelope begins with:
;;   {"call_id":"call.<16 hex digits>","request":...}
;;
;; `rho_begin` copies that actual 21-byte call ID into its terminal response.
;; A hard-coded test call ID would pass a private fixture but fail under Rho's
;; ordinary host call-ID source.
(module
  (memory (export "memory") 1 32)

  (data (i32.const 8192) "tool.local_status")
  (data (i32.const 8250) "ui.viewer.local_status")
  (data (i32.const 8400) "{\22type\22:\22complete\22,\22call_id\22:\22")
  (data (i32.const 8500) "\22,\22result\22:{\22kind\22:\22notification\22,\22message\22:\22Rho local plugin is running\22}}")
  (data (i32.const 8700) "\22,\22result\22:{\22component\22:\22local-hello\22,\22status\22:\22ready\22}}")
  (data (i32.const 8900) "\22,\22result\22:{\22contract\22:\22rho.plugin_viewer_document.v1\22,\22title\22:\22Local component status\22,\22blocks\22:[{\22kind\22:\22text\22,\22text\22:\22Rho local viewer is running\22}]}}")

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

  (func $contains
    (param $text i32)
    (param $text_length i32)
    (param $needle i32)
    (param $needle_length i32)
    (result i32)
    (local $offset i32)
    (local $index i32)
    (local $matched i32)
    (block $not_found
      (loop $search
        local.get $offset
        local.get $needle_length
        i32.add
        local.get $text_length
        i32.gt_u
        br_if $not_found

        i32.const 1
        local.set $matched
        i32.const 0
        local.set $index
        (block $compared
          (loop $compare
            local.get $index
            local.get $needle_length
            i32.ge_u
            br_if $compared

            local.get $text
            local.get $offset
            i32.add
            local.get $index
            i32.add
            i32.load8_u
            local.get $needle
            local.get $index
            i32.add
            i32.load8_u
            i32.ne
            (if
              (then
                i32.const 0
                local.set $matched
                br $compared))

            local.get $index
            i32.const 1
            i32.add
            local.set $index
            br $compare))

        local.get $matched
        (if
          (then
            i32.const 1
            return))

        local.get $offset
        i32.const 1
        i32.add
        local.set $offset
        br $search))
    i32.const 0)

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
    (local $suffix i32)
    (local $suffix_length i32)

    ;; Command is the default declared surface.
    i32.const 8500
    local.set $suffix
    i32.const 75
    local.set $suffix_length

    local.get $ptr
    local.get $len
    i32.const 8192
    i32.const 17
    call $contains
    (if
      (then
        i32.const 8700
        local.set $suffix
        i32.const 56
        local.set $suffix_length))

    local.get $ptr
    local.get $len
    i32.const 8250
    i32.const 22
    call $contains
    (if
      (then
        i32.const 8900
        local.set $suffix
        i32.const 153
        local.set $suffix_length))

    ;; Output prefix: {"type":"complete","call_id":"
    i32.const 4096
    i32.const 8400
    i32.const 30
    call $copy

    ;; Copy the actual 21-byte call ID from the host envelope.
    i32.const 4126
    local.get $ptr
    i32.const 12
    i32.add
    i32.const 21
    call $copy

    ;; Append the contribution-specific result.
    i32.const 4147
    local.get $suffix
    local.get $suffix_length
    call $copy

    ;; Pack pointer 4096 and dynamic result length into one i64.
    i64.const 17592186044416
    local.get $suffix_length
    i32.const 51
    i32.add
    i64.extend_i32_u
    i64.or)

  (func (export "rho_resume") (param i32 i32) (result i64)
    i64.const 0)

  (func (export "rho_cancel") (param i32 i32) (result i32)
    i32.const 0))
