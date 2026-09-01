use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use rho_protocol::ProjectId;
use serde::{Deserialize, Serialize};

use crate::{EvidenceGraph, GraphError, GraphHealth};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProjectGraphHealth {
    pub project_id: ProjectId,
    pub project_root: String,
    pub available: bool,
    pub graph: Option<GraphHealth>,
    pub error_code: Option<String>,
    pub message: Option<String>,
}

enum Binding {
    Ready {
        project_root: PathBuf,
        project_id: ProjectId,
        graph: EvidenceGraph,
    },
    Unavailable {
        project_root: PathBuf,
        project_id: ProjectId,
        error_code: String,
        message: String,
    },
}

#[derive(Default)]
pub struct ProjectGraphManager {
    binding: Mutex<Option<Binding>>,
}

impl ProjectGraphManager {
    pub fn activate(
        &self,
        project_root: impl AsRef<Path>,
        project_id: ProjectId,
    ) -> ProjectGraphHealth {
        let requested_root = project_root.as_ref().to_path_buf();
        let canonical_root = std::fs::canonicalize(&requested_root).unwrap_or(requested_root);
        let mut binding = self.lock();
        if let Some(current) = binding.as_ref()
            && binding_matches(current, &canonical_root, &project_id)
        {
            return binding_health(current);
        }
        match EvidenceGraph::open(&canonical_root, project_id.clone()) {
            Ok(graph) => {
                *binding = Some(Binding::Ready {
                    project_root: graph.project_root().to_path_buf(),
                    project_id,
                    graph,
                });
            }
            Err(error) => {
                *binding = Some(Binding::Unavailable {
                    project_root: canonical_root,
                    project_id,
                    error_code: error_code(&error).to_string(),
                    message: error.to_string(),
                });
            }
        }
        binding_health(binding.as_ref().unwrap())
    }

    pub fn deactivate(&self) {
        *self.lock() = None;
    }

    pub fn health(
        &self,
        project_root: impl AsRef<Path>,
        project_id: &ProjectId,
    ) -> Result<ProjectGraphHealth, GraphError> {
        let canonical_root = std::fs::canonicalize(project_root.as_ref())
            .map_err(|_| GraphError::UnsafePath(project_root.as_ref().to_path_buf()))?;
        let binding = self.lock();
        let current = binding.as_ref().ok_or_else(|| GraphError::Unavailable {
            code: "GRAPH_NOT_ACTIVATED".to_string(),
            message: "the active project graph has not been activated".to_string(),
        })?;
        if !binding_matches(current, &canonical_root, project_id) {
            return Err(GraphError::ProjectMismatch);
        }
        Ok(binding_health(current))
    }

    pub fn with_graph<R>(
        &self,
        project_root: impl AsRef<Path>,
        project_id: &ProjectId,
        operation: impl FnOnce(&EvidenceGraph) -> Result<R, GraphError>,
    ) -> Result<R, GraphError> {
        let canonical_root = std::fs::canonicalize(project_root.as_ref())
            .map_err(|_| GraphError::UnsafePath(project_root.as_ref().to_path_buf()))?;
        let binding = self.lock();
        match binding.as_ref() {
            Some(Binding::Ready {
                project_root,
                project_id: bound_project,
                graph,
            }) if project_root == &canonical_root && bound_project == project_id => {
                operation(graph)
            }
            Some(Binding::Unavailable {
                project_root,
                project_id: bound_project,
                error_code,
                message,
            }) if project_root == &canonical_root && bound_project == project_id => {
                Err(GraphError::Unavailable {
                    code: error_code.clone(),
                    message: message.clone(),
                })
            }
            Some(_) => Err(GraphError::ProjectMismatch),
            None => Err(GraphError::Unavailable {
                code: "GRAPH_NOT_ACTIVATED".to_string(),
                message: "the active project graph has not been activated".to_string(),
            }),
        }
    }

    pub fn with_graph_mut<R>(
        &self,
        project_root: impl AsRef<Path>,
        project_id: &ProjectId,
        operation: impl FnOnce(&mut EvidenceGraph) -> Result<R, GraphError>,
    ) -> Result<R, GraphError> {
        let canonical_root = std::fs::canonicalize(project_root.as_ref())
            .map_err(|_| GraphError::UnsafePath(project_root.as_ref().to_path_buf()))?;
        let mut binding = self.lock();
        match binding.as_mut() {
            Some(Binding::Ready {
                project_root,
                project_id: bound_project,
                graph,
            }) if project_root == &canonical_root && bound_project == project_id => {
                operation(graph)
            }
            Some(Binding::Unavailable {
                project_root,
                project_id: bound_project,
                error_code,
                message,
            }) if project_root == &canonical_root && bound_project == project_id => {
                Err(GraphError::Unavailable {
                    code: error_code.clone(),
                    message: message.clone(),
                })
            }
            Some(_) => Err(GraphError::ProjectMismatch),
            None => Err(GraphError::Unavailable {
                code: "GRAPH_NOT_ACTIVATED".to_string(),
                message: "the active project graph has not been activated".to_string(),
            }),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Option<Binding>> {
        self.binding
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

fn binding_matches(binding: &Binding, root: &Path, project_id: &ProjectId) -> bool {
    match binding {
        Binding::Ready {
            project_root,
            project_id: bound_project,
            ..
        }
        | Binding::Unavailable {
            project_root,
            project_id: bound_project,
            ..
        } => project_root == root && bound_project == project_id,
    }
}

fn binding_health(binding: &Binding) -> ProjectGraphHealth {
    match binding {
        Binding::Ready {
            project_root,
            project_id,
            graph,
        } => match graph.health() {
            Ok(health) => ProjectGraphHealth {
                project_id: project_id.clone(),
                project_root: normalized(project_root),
                available: true,
                graph: Some(health),
                error_code: None,
                message: None,
            },
            Err(error) => ProjectGraphHealth {
                project_id: project_id.clone(),
                project_root: normalized(project_root),
                available: false,
                graph: None,
                error_code: Some(error_code(&error).to_string()),
                message: Some(error.to_string()),
            },
        },
        Binding::Unavailable {
            project_root,
            project_id,
            error_code,
            message,
        } => ProjectGraphHealth {
            project_id: project_id.clone(),
            project_root: normalized(project_root),
            available: false,
            graph: None,
            error_code: Some(error_code.clone()),
            message: Some(message.clone()),
        },
    }
}

fn normalized(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn error_code(error: &GraphError) -> &'static str {
    match error {
        GraphError::Ladybug(_) => "GRAPH_ENGINE_UNAVAILABLE",
        GraphError::UnsafePath(_) => "GRAPH_UNSAFE_PATH",
        GraphError::SchemaResetRequired { .. } => "GRAPH_SCHEMA_RESET_REQUIRED",
        GraphError::DatabaseProjectMismatch | GraphError::ProjectMismatch => {
            "GRAPH_PROJECT_MISMATCH"
        }
        GraphError::Invariant(_) => "GRAPH_INVARIANT_FAILED",
        _ => "GRAPH_UNAVAILABLE",
    }
}
