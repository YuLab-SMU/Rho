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
#ifdef _WIN32
#include <windows.h>
#include <wchar.h>
#endif

#define VISITED_SIZE 262144
#define NODE_LIMIT 100000
static SEXP compact_integer = NULL, compact_real = NULL;
typedef struct { SEXP *seen, *accepted; size_t *touched; size_t nodes, count, steps, existing_nodes; SEXP *packages; size_t package_count; double bytes, limit, seconds; struct timespec start; const char *reason; } Graph;
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
    if (((++g->steps) & 1023) == 0) budget(g);
    if (g->accepted[slot_for(g->accepted,x)] == x) return 1;
    size_t slot = slot_for(g->seen,x);
    if (g->seen[slot] == x) return 1;
    if (g->existing_nodes+(++g->nodes)>NODE_LIMIT) {g->reason="graph_node_limit";return 0;}
    g->seen[slot] = x;
    g->touched[g->count++] = slot;
    SEXP class_names=(OBJECT(x)||IS_S4_OBJECT(x))?Rf_getAttrib(x,R_ClassSymbol):R_NilValue;
    SEXP class_package=TYPEOF(class_names)==STRSXP?Rf_getAttrib(class_names,R_PackageSymbol):R_NilValue;
    if (TYPEOF(class_package)==STRSXP && !ALTREP(class_package) && XLENGTH(class_package)==1 && STRING_ELT(class_package,0)!=NA_STRING) {
        SEXP name=STRING_ELT(class_package,0);
        if(!strcmp(CHAR(name),".GlobalEnv")){g->reason="project_class_requires_reconstruction";return 0;}
        if(LENGTH(name)>128){g->reason="unsupported_class_package_identity";return 0;}
        int found=0;
        for(size_t i=0;i<g->package_count;i++)if(!strcmp(CHAR(g->packages[i]),CHAR(name))){found=1;break;}
        if(!found){if(g->package_count>=128){g->reason="package_dependency_limit";return 0;}g->packages[g->package_count++]=name;}
    }
    if (ALTREP(x)) {
        /* Never call an unknown provider's length/data/serialization hooks. */
        SEXP cls = ALTREP_CLASS(x);
        if (cls != compact_integer && cls != compact_real) {
            SEXP info=ATTRIB(cls);
            int base_altrep=0;
            if (TYPEOF(info)==LISTSXP && TYPEOF(CAR(info))==SYMSXP && TYPEOF(CDR(info))==LISTSXP && TYPEOF(CAR(CDR(info)))==SYMSXP && !strcmp(CHAR(PRINTNAME(CAR(CDR(info)))),"base")) {
                const char *name=CHAR(PRINTNAME(CAR(info)));
                base_altrep=(TYPEOF(x)==REALSXP&&!strcmp(name,"wrap_real")) || (TYPEOF(x)==INTSXP&&!strcmp(name,"wrap_integer")) || (TYPEOF(x)==LGLSXP&&!strcmp(name,"wrap_logical")) || (TYPEOF(x)==STRSXP&&!strcmp(name,"wrap_string")) || (TYPEOF(x)==RAWSXP&&!strcmp(name,"wrap_raw")) || (TYPEOF(x)==CPLXSXP&&!strcmp(name,"wrap_complex"))
                    /* Base deferred conversions also serialize to an immutable
                     * materialized value. Fitted models with factor terms carry one
                     * in their residual/fitted/effects names, so excluding it would
                     * make an ordinary model unrecoverable. */
                    || (TYPEOF(x)==STRSXP&&!strcmp(name,"deferred_string"));
            }
            if (!base_altrep) {g->reason="unknown_altrep_provider";return 0;}
            /* A base ALTREP serializes to an immutable value. Inspect its actual
             * payload before allowing its base serializer; foreign nested ALTREP
             * remains excluded and no provider accessor is called here. */
            return visit(g,R_altrep_data1(x),depth+1) && visit(g,R_altrep_data2(x),depth+1) && visit(g,ATTRIB(x),depth+1);
        }
        g->bytes += (double)XLENGTH(x) * (TYPEOF(x) == INTSXP ? 4 : 8);
        if (g->bytes > g->limit) { g->reason = "graph_byte_limit"; return 0; }
        return visit(g, ATTRIB(x), depth + 1);
    }
    g->bytes += 64;
    if (g->bytes > g->limit) { g->reason = "graph_byte_limit"; return 0; }
    switch (TYPEOF(x)) {
    case EXTPTRSXP: case WEAKREFSXP: g->reason = "external_resource"; return 0;
    case PROMSXP:
        return visit(g,PRVALUE(x),depth+1) && visit(g,PREXPR(x),depth+1) && visit(g,PRENV(x),depth+1);
    case ENVSXP: {
        if (x == R_GlobalEnv || x == R_BaseEnv || x == R_EmptyEnv || x == R_BaseNamespace) return 1;
        if (R_IsNamespaceEnv(x)) {
            SEXP spec=PROTECT(R_NamespaceEnvSpec(x));
            const char *name=TYPEOF(spec)==STRSXP && XLENGTH(spec)>0 ? CHAR(STRING_ELT(spec,0)) : "";
            int allowed=!strcmp(name,"stats")||!strcmp(name,"utils")||!strcmp(name,"methods")||!strcmp(name,"graphics")||!strcmp(name,"grDevices");
            UNPROTECT(1);
            if (allowed) return 1;
            g->reason="package_environment";return 0;
        }
        if (R_IsPackageEnv(x)) { g->reason = "package_environment"; return 0; }
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
        if(g->bytes>g->limit){g->reason="graph_byte_limit";return 0;}
        for (R_xlen_t i = 0; i < XLENGTH(x); i++) if (!visit(g, VECTOR_ELT(x, i), depth + 1)) return 0;
        break;
    case STRSXP:
        g->bytes += (double)XLENGTH(x) * sizeof(SEXP);
        if(g->bytes>g->limit){g->reason="graph_byte_limit";return 0;}
        for (R_xlen_t i = 0; i < XLENGTH(x); i++) if (!visit(g, STRING_ELT(x, i), depth + 1)) return 0;
        break;
    case CHARSXP: g->bytes += LENGTH(x); return g->bytes <= g->limit;
    case LGLSXP: case INTSXP: g->bytes += (double)XLENGTH(x) * 4; break;
    case REALSXP: g->bytes += (double)XLENGTH(x) * 8; break;
    case CPLXSXP: g->bytes += (double)XLENGTH(x) * 16; break;
    case RAWSXP: g->bytes += (double)XLENGTH(x); break;
    case SYMSXP: case BUILTINSXP: case SPECIALSXP: return 1;
    case BCODESXP:
        if (!visit(g,BCODE_CONSTS(x),depth+1)) return 0;
        break;
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
    SEXP *packages=(SEXP *)R_alloc(128,sizeof(SEXP));
    Graph graph = {0}; graph.packages=packages; graph.seen=seen; graph.accepted=accepted_seen; graph.touched=touched;
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
        if (env==R_GlobalEnv && (!strcmp(CHAR(STRING_ELT(names,i)),".Last.value") || !strcmp(CHAR(STRING_ELT(names,i)),".Traceback"))) reason="internal_transient";
        else if (!selected) reason = "excluded_by_policy";
        else if (accepted_count >= NODE_LIMIT) reason = "graph_node_limit";
        else if (R_BindingIsActive(sym, env)) reason = "active_binding";
        else {
            value = Rf_findVarInFrame(env, sym);
            if (TYPEOF(value) == PROMSXP && PRVALUE(value) == R_UnboundValue) {
                LOGICAL(accepted)[i]=0;SET_STRING_ELT(reasons,i,Rf_mkChar("promise"));continue;
            }
            if (TYPEOF(value) == PROMSXP) value = PRVALUE(value);
            size_t previous_packages=graph.package_count;
            graph.nodes=0; graph.steps=0; graph.existing_nodes=accepted_count; graph.count=0; graph.bytes=0; graph.limit=remaining; graph.reason="graph_byte_limit";
            ok = visit(&graph, value, 0);
            reason = ok ? "" : graph.reason;
            if (ok) {
                remaining -= graph.bytes;
                for (size_t j=0;j<graph.count;j++) {SEXP v=seen[touched[j]];size_t at=slot_for(accepted_seen,v);if (!accepted_seen[at]) {accepted_seen[at]=v;accepted_count++;}}
            }
            if(!ok)graph.package_count=previous_packages;
            for (size_t j=0;j<graph.count;j++) seen[touched[j]]=NULL;
        }
        LOGICAL(accepted)[i] = ok;
        SET_STRING_ELT(reasons, i, Rf_mkChar(reason));
        if (ok) SET_VECTOR_ELT(values, i, value);
    }
    Rf_setAttrib(values, R_NamesSymbol, names);
    SEXP out = PROTECT(Rf_allocVector(VECSXP, 6));
    SET_VECTOR_ELT(out, 0, names); SET_VECTOR_ELT(out, 1, values);
    SET_VECTOR_ELT(out, 2, accepted); SET_VECTOR_ELT(out, 3, reasons);
    SET_VECTOR_ELT(out, 4, Rf_ScalarReal(elapsed(graph.start)));
    SEXP package_names=PROTECT(Rf_allocVector(STRSXP,graph.package_count));
    for(size_t i=0;i<graph.package_count;i++)SET_STRING_ELT(package_names,i,packages[i]);
    SET_VECTOR_ELT(out,5,package_names);UNPROTECT(1);
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
    #ifdef _WIN32
    const char *utf8=Rf_translateCharUTF8(STRING_ELT(path,0));
    int count=MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,utf8,-1,NULL,0);
    if(count<=0)Rf_error("Checkpoint path is not valid UTF-8");
    wchar_t *wide=(wchar_t *)R_alloc((size_t)count,sizeof(wchar_t));
    if(MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,utf8,-1,wide,count)!=count)Rf_error("Checkpoint path conversion failed");
    w.file=_wfopen(wide,L"wbx");
#else
    w.file = fopen(R_ExpandFileName(Rf_translateCharUTF8(STRING_ELT(path, 0))), "wbx");
#endif
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
