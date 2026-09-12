/* Test-only provider: classification must reject this graph without asking the
 * provider for its length, data or serialized state. Never shipped with Rho. */
#include <R.h>
#include <Rinternals.h>
#include <R_ext/Altrep.h>
#include <R_ext/Rdynload.h>
#include <R_ext/Visibility.h>

static R_altrep_class_t fixture_class;
static int calls;
static R_xlen_t fixture_length(SEXP x) { calls++; return 10; }
static int fixture_element(SEXP x, R_xlen_t i) { calls++; return (int)i + 1; }
static void *fixture_data(SEXP x, Rboolean writable) {
    calls++; Rf_error("Unknown ALTREP data accessor was called"); return NULL;
}
static const void *fixture_data_or_null(SEXP x) { calls++; return NULL; }
static SEXP fixture_serialized(SEXP x) {
    calls++; Rf_error("Unknown ALTREP serializer was called"); return R_NilValue;
}
static SEXP make_fixture(void) { return R_new_altrep(fixture_class, R_NilValue, R_NilValue); }
static SEXP access_count(SEXP reset) {
    int previous = calls;
    if (Rf_asLogical(reset)) calls = 0;
    return Rf_ScalarInteger(previous);
}
static const R_CallMethodDef methods[] = {
    {"make_fixture", (DL_FUNC)&make_fixture, 0},
    {"access_count", (DL_FUNC)&access_count, 1},
    {NULL, NULL, 0}
};
void attribute_visible R_init_rho_altrep_fixture(DllInfo *info) {
    /* Even a familiar class name must not authorize a foreign provider. */
    fixture_class = R_make_altinteger_class("wrap_integer", "rho_test_provider", info);
    R_set_altrep_Length_method(fixture_class, fixture_length);
    R_set_altinteger_Elt_method(fixture_class, fixture_element);
    R_set_altvec_Dataptr_method(fixture_class, fixture_data);
    R_set_altvec_Dataptr_or_null_method(fixture_class, fixture_data_or_null);
    R_set_altrep_Serialized_state_method(fixture_class, fixture_serialized);
    R_registerRoutines(info, NULL, methods, NULL, NULL);
    R_useDynamicSymbols(info, FALSE);
    R_forceSymbols(info, TRUE);
}
