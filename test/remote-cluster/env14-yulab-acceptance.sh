#!/usr/bin/env bash
set -euo pipefail

acceptance_root=${1:?usage: env14-yulab-acceptance.sh ACCEPTANCE_ROOT}
case "$acceptance_root" in
  /biostack/home/yonghe/projects/rho-env14-*) ;;
  *) printf 'refusing unexpected acceptance root: %s\n' "$acceptance_root" >&2; exit 64 ;;
esac

r_root=/biostack/tools/devtools/R/4.5.2
r_bin=$r_root/bin
module_file=/biostack/opt/modulefiles/R/4.5.2
conda_bin=/biostack/home/yonghe/miniconda/bin/conda
conda_prefix=/biostack/home/yonghe/codex_test_tidyverse/conda_env
apptainer_bin=/biostack/home/yonghe/tools/apptainer-unprivileged/bin/apptainer

mkdir -p "$acceptance_root"/{source,staging,logs,receipts}
chmod 700 "$acceptance_root"
package_root=$acceptance_root/source/rhoenvaccept
mkdir -p "$package_root/R"
printf '%s\n' \
  'Package: rhoenvaccept' \
  'Type: Package' \
  'Title: Rho Environment Acceptance Fixture' \
  'Version: 0.0.1' \
  'Authors@R: person("Rho", "Acceptance", email = "noreply@example.invalid", role = c("aut", "cre"))' \
  'Description: Hermetic package used only to verify compute-node Environment realization.' \
  'License: MIT' \
  'Encoding: UTF-8' \
  'NeedsCompilation: no' > "$package_root/DESCRIPTION"
printf '%s\n' 'export(rho_env_accept)' > "$package_root/NAMESPACE"
printf '%s\n' 'rho_env_accept <- function() "ok"' > "$package_root/R/accept.R"
package_archive=$acceptance_root/source/rhoenvaccept_0.0.1.tar.gz
tar -C "$acceptance_root/source" -czf "$package_archive" rhoenvaccept
package_digest=$(sha256sum "$package_archive" | cut -d' ' -f1)
chmod -R a-w "$acceptance_root/source"

login_module_digest=$(sha256sum "$module_file" | cut -d' ' -f1)
login_r_version=$(R_ENVIRON_USER=/dev/null R_PROFILE_USER=/dev/null "$r_bin/Rscript" --vanilla -e 'cat(as.character(getRversion()))')
login_r_home=$(R_ENVIRON_USER=/dev/null R_PROFILE_USER=/dev/null "$r_bin/Rscript" --vanilla -e 'cat(R.home())')
"$conda_bin" list --explicit --prefix "$conda_prefix" > "$acceptance_root/conda-explicit.txt"
login_conda_digest=$(sha256sum "$acceptance_root/conda-explicit.txt" | cut -d' ' -f1)
login_storage=$(df -PT "$acceptance_root" | tail -n 1 | tr -s ' ' | cut -d' ' -f1,2,7 | tr ' ' '|')
apptainer_version=$("$apptainer_bin" version)

environment_manifest=$acceptance_root/environment-manifest.txt
printf '%s\n' \
  "r_version=$login_r_version" \
  "r_home=$login_r_home" \
  "module_digest=sha256:$login_module_digest" \
  "conda_prefix=$conda_prefix" \
  "conda_explicit_digest=sha256:$login_conda_digest" \
  "storage=$login_storage" \
  "apptainer=$apptainer_version" \
  "package_digest=sha256:$package_digest" > "$environment_manifest"
environment_manifest_digest=$(sha256sum "$environment_manifest" | cut -d' ' -f1)
chmod a-w "$environment_manifest" "$acceptance_root/conda-explicit.txt"

job_script=$acceptance_root/env14-compute.sbatch
{
  printf '%s\n' '#!/usr/bin/env bash'
  printf '%s\n' '#SBATCH --partition=cpu_batch'
  printf '%s\n' '#SBATCH --account=yonghe'
  printf '%s\n' '#SBATCH --cpus-per-task=1'
  printf '%s\n' '#SBATCH --mem=512M'
  printf '%s\n' '#SBATCH --time=00:05:00'
  printf '%s\n' '#SBATCH --export=NIL'
  printf '#SBATCH --job-name=%s\n' 'rho-env14-accept'
  printf '#SBATCH --comment=%s\n' 'rho-operation-env14-yulab-acceptance'
  printf '#SBATCH --output=%s\n' "$acceptance_root/logs/compute-%j.out"
  printf '#SBATCH --error=%s\n' "$acceptance_root/logs/compute-%j.err"
  printf 'acceptance_root=%q\n' "$acceptance_root"
  printf 'r_bin=%q\n' "$r_bin"
  printf 'module_file=%q\n' "$module_file"
  printf 'conda_bin=%q\n' "$conda_bin"
  printf 'conda_prefix=%q\n' "$conda_prefix"
  printf 'package_archive=%q\n' "$package_archive"
  printf 'expected_package_digest=%q\n' "$package_digest"
  printf 'expected_manifest_digest=%q\n' "$environment_manifest_digest"
  printf 'expected_module_digest=%q\n' "$login_module_digest"
  printf 'expected_conda_digest=%q\n' "$login_conda_digest"
  printf 'expected_r_version=%q\n' "$login_r_version"
  cat <<'COMPUTE_BODY'
set -euo pipefail
export PATH=/usr/bin:/bin
export HOME="$acceptance_root/staging/home"
export TMPDIR="$acceptance_root/staging/tmp"
export R_ENVIRON_USER=/dev/null
export R_PROFILE_USER=/dev/null
export R_LIBS_USER="$acceptance_root/staging/library"
export RHO_BUILD_NETWORK=deny
export http_proxy=http://127.0.0.1:9
export https_proxy=http://127.0.0.1:9
export HTTP_PROXY=http://127.0.0.1:9
export HTTPS_PROXY=http://127.0.0.1:9
mkdir -p "$HOME" "$TMPDIR" "$R_LIBS_USER"

actual_package_digest=$(sha256sum "$package_archive" | cut -d' ' -f1)
actual_manifest_digest=$(sha256sum "$acceptance_root/environment-manifest.txt" | cut -d' ' -f1)
actual_module_digest=$(sha256sum "$module_file" | cut -d' ' -f1)
"$conda_bin" list --explicit --prefix "$conda_prefix" > "$acceptance_root/staging/compute-conda-explicit.txt"
actual_conda_digest=$(sha256sum "$acceptance_root/staging/compute-conda-explicit.txt" | cut -d' ' -f1)
actual_r_version=$("$r_bin/Rscript" --vanilla -e 'cat(as.character(getRversion()))')
test "$actual_package_digest" = "$expected_package_digest"
test "$actual_manifest_digest" = "$expected_manifest_digest"
test "$actual_module_digest" = "$expected_module_digest"
test "$actual_conda_digest" = "$expected_conda_digest"
test "$actual_r_version" = "$expected_r_version"
test "$RHO_BUILD_NETWORK" = deny

"$r_bin/R" CMD INSTALL --library="$R_LIBS_USER" --no-multiarch --no-test-load "$package_archive"
"$r_bin/Rscript" --vanilla -e 'library(rhoenvaccept); stopifnot(identical(rho_env_accept(), "ok")); cat(as.character(packageVersion("rhoenvaccept")))' > "$acceptance_root/staging/namespace-version.txt"
library_digest=$(find "$R_LIBS_USER" -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1)
compute_storage=$(df -PT "$acceptance_root" | tail -n 1 | tr -s ' ' | cut -d' ' -f1,2,7 | tr ' ' '|')
receipt_tmp="$acceptance_root/receipts/environment-receipt.json.tmp"
receipt="$acceptance_root/receipts/environment-receipt.json"
printf '{\n  "schema":"rho.environment.yulab.acceptance.v1",\n  "operation_id":"operation_env14_yulab_acceptance",\n  "slurm_job_id":"%s",\n  "compute_host":"%s",\n  "package_archive_digest":"sha256:%s",\n  "environment_manifest_digest":"sha256:%s",\n  "module_digest":"sha256:%s",\n  "conda_explicit_digest":"sha256:%s",\n  "r_version":"%s",\n  "library_digest":"sha256:%s",\n  "storage":"%s",\n  "network_policy_requested":"deny",\n  "network_enforcement":"proxy_environment_only",\n  "offline_inputs_verified":true,\n  "namespace_probe":"passed",\n  "outcome":"succeeded"\n}\n' \
  "$SLURM_JOB_ID" "$(hostname)" "$actual_package_digest" "$actual_manifest_digest" \
  "$actual_module_digest" "$actual_conda_digest" "$actual_r_version" "$library_digest" \
  "$compute_storage" > "$receipt_tmp"
mv "$receipt_tmp" "$receipt"
COMPUTE_BODY
} > "$job_script"
chmod 700 "$job_script"

sbatch --wait --parsable "$job_script" | tee "$acceptance_root/sbatch-id.txt"
job_id=$(cut -d';' -f1 "$acceptance_root/sbatch-id.txt" | tail -n 1)
sacct -X -n -P -j "$job_id" -o JobID,State,ExitCode,Elapsed,NodeList,Account,Partition > "$acceptance_root/sacct.txt"
cat "$acceptance_root/receipts/environment-receipt.json"
printf 'acceptance_root=%s\njob_id=%s\n' "$acceptance_root" "$job_id"
