/* Rho's conservative graph checkpoint provider. No R callbacks or user methods.
 * R serialization itself is restricted to ordinary storage and known base compact
 * sequence ALTREP classes. Unsupported reference resources exclude the whole root.
 */
#include <R.h>
#include <Rinternals.h>
#include <R_ext/Rdynload.h>
#include <R_ext/Visibility.h>
#include <stdint.h>
#include <string.h>
#include <stdio.h>
#include <time.h>

#define VISITED_SIZE 262144
#define NODE_LIMIT 100000
static SEXP compact_integer = NULL, compact_real = NULL;
typedef struct { SEXP *seen, *accepted; size_t *touched; size_t nodes, count; double bytes, limit, seconds; struct timespec start; const char *reason; } Graph;
static double elapsed(struct timespec start) { struct timespec now; timespec_get(&now, TIME_UTC); return (now.tv_sec-start.tv_sec)+(now.tv_nsec-start.tv_nsec)/1e9; }
static void budget(Graph *g) { R_CheckUserInterrupt(); if (elapsed(g->start) > g->seconds) Rf_error("Checkpoint classification time budget exceeded"); }
static size_t slot_for(SEXP *table, SEXP x) {
    size_t slot = (((uintptr_t)x >> 3) * 11400714819323198485ull) & (VISITED_SIZE - 1);
    while (table[slot] && table[slot] != x) slot = (slot + 1) & (VISITED_SIZE - 1);
    return slot;
}
static int visit(Graph *g, SEXP x, int depth) {
    if (x == R_NilValue || x == R_UnboundValue || x == R_MissingArg) return 1;
    if (depth > 128) { g->reason = "graph_depth_limit"; return 0; }
    if (++g->nodes > NODE_LIMIT) { g->reason = "graph_node_limit"; return 0; }
    if ((g->nodes & 1023) == 0) budget(g);
    if (g->accepted[slot_for(g->accepted,x)] == x) return 1;
    size_t slot = slot_for(g->seen,x);
    if (g->seen[slot] == x) return 1;
    g->seen[slot] = x;
    g->touched[g->count++] = slot;
    if (ALTREP(x)) {
        /* Never call an unknown provider's length/data/serialization hooks. */
        SEXP cls = ALTREP_CLASS(x);
        if (cls != compact_integer && cls != compact_real) { g->reason = "unknown_altrep_provider"; return 0; }
        g->bytes += (double)XLENGTH(x) * (TYPEOF(x) == INTSXP ? 4 : 8);
        if (g->bytes > g->limit) { g->reason = "graph_byte_limit"; return 0; }
        return visit(g, ATTRIB(x), depth + 1);
    }
    g->bytes += 64;
    if (g->bytes > g->limit) { g->reason = "graph_byte_limit"; return 0; }
    switch (TYPEOF(x)) {
    case EXTPTRSXP: case WEAKREFSXP: g->reason = "external_resource"; return 0;
    case PROMSXP: g->reason = "promise"; return 0;
    case ENVSXP: {
        if (x == R_GlobalEnv || x == R_BaseEnv || x == R_EmptyEnv || x == R_BaseNamespace) return 1;
        if (R_IsNamespaceEnv(x) || R_IsPackageEnv(x)) { g->reason = "package_environment"; return 0; }
        SEXP names = PROTECT(R_lsInternal3(x, TRUE, FALSE));
        for (R_xlen_t i = 0; i < XLENGTH(names); i++) {
            SEXP sym = Rf_installChar(STRING_ELT(names, i));
            if (R_BindingIsActive(sym, x)) { g->reason = "nested_active_binding"; UNPROTECT(1); return 0; }
            if (!visit(g, Rf_findVarInFrame(x, sym), depth + 1)) { UNPROTECT(1); return 0; }
        }
        UNPROTECT(1);
        if (!visit(g, ENCLOS(x), depth + 1)) return 0;
        break;
    }
    case CLOSXP:
        if (!visit(g, FORMALS(x), depth + 1) || !visit(g, BODY(x), depth + 1) || !visit(g, CLOENV(x), depth + 1)) return 0;
        break;
    case LISTSXP: case LANGSXP: case DOTSXP:
        if (!visit(g, CAR(x), depth + 1) || !visit(g, CDR(x), depth + 1) || !visit(g, TAG(x), depth + 1)) return 0;
        break;
    case VECSXP: case EXPRSXP:
        g->bytes += (double)XLENGTH(x) * sizeof(SEXP);
        for (R_xlen_t i = 0; i < XLENGTH(x); i++) if (!visit(g, VECTOR_ELT(x, i), depth + 1)) return 0;
        break;
    case STRSXP:
        g->bytes += (double)XLENGTH(x) * sizeof(SEXP);
        for (R_xlen_t i = 0; i < XLENGTH(x); i++) if (!visit(g, STRING_ELT(x, i), depth + 1)) return 0;
        break;
    case CHARSXP: g->bytes += LENGTH(x); return g->bytes <= g->limit;
    case LGLSXP: case INTSXP: g->bytes += (double)XLENGTH(x) * 4; break;
    case REALSXP: g->bytes += (double)XLENGTH(x) * 8; break;
    case CPLXSXP: g->bytes += (double)XLENGTH(x) * 16; break;
    case RAWSXP: g->bytes += (double)XLENGTH(x); break;
    case SYMSXP: case BUILTINSXP: case SPECIALSXP: return 1;
    case S4SXP: break;
    default: g->reason = "unsupported_native_storage"; return 0;
    }
    if (g->bytes > g->limit) { g->reason = "graph_byte_limit"; return 0; }
    return visit(g, ATTRIB(x), depth + 1);
}
static SEXP initialize(SEXP integer, SEXP real) {
    if (!ALTREP(integer) || !ALTREP(real)) Rf_error("Base compact sequence providers unavailable");
    compact_integer = ALTREP_CLASS(integer); compact_real = ALTREP_CLASS(real);
    return Rf_ScalarLogical(1);
}
static SEXP roots(SEXP env, SEXP byte_limit, SEXP seconds, SEXP selection) {
    if (TYPEOF(env) != ENVSXP || !compact_integer) Rf_error("Checkpoint provider not initialized");
    SEXP names = PROTECT(R_lsInternal3(env, TRUE, TRUE));
    if (XLENGTH(names) > 10000) Rf_error("Checkpoint binding limit exceeded (10000)");
    SEXP values = PROTECT(Rf_allocVector(VECSXP, XLENGTH(names)));
    SEXP reasons = PROTECT(Rf_allocVector(STRSXP, XLENGTH(names)));
    SEXP accepted = PROTECT(Rf_allocVector(LGLSXP, XLENGTH(names)));
    SEXP *seen = (SEXP *)R_alloc(VISITED_SIZE, sizeof(SEXP));
    SEXP *accepted_seen = (SEXP *)R_alloc(VISITED_SIZE, sizeof(SEXP));
    size_t *touched = (size_t *)R_alloc(VISITED_SIZE, sizeof(size_t));
    memset(seen,0,VISITED_SIZE*sizeof(SEXP)); memset(accepted_seen,0,VISITED_SIZE*sizeof(SEXP));
    size_t accepted_count = 0;
    Graph graph = {0}; graph.seen=seen; graph.accepted=accepted_seen; graph.touched=touched;
    graph.seconds=Rf_asReal(seconds); timespec_get(&graph.start,TIME_UTC);
    double remaining = Rf_asReal(byte_limit);
    for (R_xlen_t i = 0; i < XLENGTH(names); i++) {
        budget(&graph);
        SEXP sym = Rf_installChar(STRING_ELT(names, i));
        const char *reason = "";
        SEXP value = R_NilValue;
        int ok = 0;
        int selected = selection == R_NilValue;
        if (!selected) for (R_xlen_t j=0;j<XLENGTH(selection);j++) if (strcmp(CHAR(STRING_ELT(names,i)),CHAR(STRING_ELT(selection,j)))==0) {selected=1;break;}
        if (!selected) reason = "excluded_by_policy";
        else if (accepted_count >= NODE_LIMIT) reason = "graph_node_limit";
        else if (R_BindingIsActive(sym, env)) reason = "active_binding";
        else {
            value = Rf_findVarInFrame(env, sym);
            if (TYPEOF(value) == PROMSXP && PRVALUE(value) != R_UnboundValue) value = PRVALUE(value);
            graph.nodes=0; graph.count=0; graph.bytes=0; graph.limit=remaining; graph.reason="graph_byte_limit";
            ok = visit(&graph, value, 0);
            reason = ok ? "" : graph.reason;
            if (ok) {
                remaining -= graph.bytes;
                for (size_t j=0;j<graph.count;j++) {SEXP v=seen[touched[j]];size_t at=slot_for(accepted_seen,v);if (!accepted_seen[at]) {accepted_seen[at]=v;accepted_count++;}}
            }
            for (size_t j=0;j<graph.count;j++) seen[touched[j]]=NULL;
        }
        LOGICAL(accepted)[i] = ok;
        SET_STRING_ELT(reasons, i, Rf_mkChar(reason));
        if (ok) SET_VECTOR_ELT(values, i, value);
    }
    Rf_setAttrib(values, R_NamesSymbol, names);
    SEXP out = PROTECT(Rf_allocVector(VECSXP, 5));
    SET_VECTOR_ELT(out, 0, names); SET_VECTOR_ELT(out, 1, values);
    SET_VECTOR_ELT(out, 2, accepted); SET_VECTOR_ELT(out, 3, reasons);
    SET_VECTOR_ELT(out, 4, Rf_ScalarReal(elapsed(graph.start)));
    UNPROTECT(5); return out;
}
typedef struct { FILE *file; double bytes, limit, seconds; struct timespec start; SEXP value; } Writer;
static void output_bytes(R_outpstream_t stream, void *buf, int size) {
    Writer *w = (Writer *)stream->data;
    if (size < 0 || w->bytes + size > w->limit) Rf_error("Checkpoint serialized byte limit exceeded");
    const unsigned char *p = (const unsigned char *)buf;
    while (size > 0) {
        R_CheckUserInterrupt();
        struct timespec now; timespec_get(&now, TIME_UTC);
        double elapsed = (now.tv_sec - w->start.tv_sec) + (now.tv_nsec - w->start.tv_nsec) / 1e9;
        if (elapsed > w->seconds) Rf_error("Checkpoint time budget exceeded");
        size_t n = size > 65536 ? 65536 : (size_t)size;
        if (fwrite(p, 1, n, w->file) != n) Rf_error("Checkpoint artifact write failed");
        p += n; size -= (int)n; w->bytes += n;
    }
}
static void output_char(R_outpstream_t stream, int value) { unsigned char v = (unsigned char)value; output_bytes(stream, &v, 1); }
static SEXP serialize_body(void *data) {
    Writer *w = data;
    struct R_outpstream_st stream;
    R_InitOutPStream(&stream, w, R_pstream_xdr_format, 3, output_char, output_bytes, NULL, R_NilValue);
    R_Serialize(w->value, &stream);
    if (fflush(w->file)) Rf_error("Checkpoint artifact flush failed");
    return Rf_ScalarReal(w->bytes);
}
static void cleanup(void *data, Rboolean jump) { (void)jump; Writer *w = data; if (w->file) { fclose(w->file); w->file = NULL; } }
static SEXP write_graph(SEXP value, SEXP path, SEXP limit, SEXP seconds) {
    if (TYPEOF(path) != STRSXP || XLENGTH(path) != 1) Rf_error("Invalid checkpoint path");
    Writer w = {0}; w.value = value; w.limit = Rf_asReal(limit); w.seconds = Rf_asReal(seconds);
    timespec_get(&w.start, TIME_UTC);
    w.file = fopen(R_ExpandFileName(CHAR(STRING_ELT(path, 0))), "wbx");
    if (!w.file) Rf_error("Cannot create a new checkpoint artifact");
    return R_UnwindProtect(serialize_body, &w, cleanup, &w, NULL);
}
static const R_CallMethodDef calls[] = {
    {"rho_checkpoint_initialize", (DL_FUNC)&initialize, 2},
    {"rho_checkpoint_roots", (DL_FUNC)&roots, 4},
    {"rho_checkpoint_write", (DL_FUNC)&write_graph, 4},
    {NULL, NULL, 0}
};
void attribute_visible R_init_rho_checkpoint(DllInfo *dll) { R_registerRoutines(dll, NULL, calls, NULL, NULL); R_useDynamicSymbols(dll, FALSE); }
