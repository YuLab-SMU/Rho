use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::{
    BlockId, CommandId, ContractError, PageId, ProjectId, ResourceBindingV1, SectionId,
    SurfaceInstanceId, Validate, encoded_json_len, ensure_revision, next_revision, validate_label,
    validate_unique,
};

pub const MAX_VIBE_PAGE_JSON_BYTES: usize = 1024 * 1024;
pub const MAX_VIBE_SECTIONS: usize = 64;
pub const MAX_VIBE_BLOCKS: usize = 256;
pub const MAX_VIBE_LIVE_SURFACES: usize = 24;
pub const MAX_VIBE_TEXT_BYTES: usize = 64 * 1024;
pub const MAX_VIBE_GRID_COLUMNS: u8 = 12;
pub const MAX_VIBE_GRID_ROWS: u16 = 256;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum VibeCalloutToneV1 {
    Neutral,
    Info,
    Success,
    Warning,
    Danger,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum VibeBlockContentV1 {
    RichText {
        text: String,
    },
    Callout {
        tone: VibeCalloutToneV1,
        text: String,
    },
    Divider,
    FileExcerpt {
        resource: ResourceBindingV1,
        start_line: u64,
        end_line: u64,
    },
    ArtifactRef {
        artifact_id: String,
        label: String,
    },
    FindingRef {
        finding_id: String,
        label: String,
    },
    TaskRef {
        task_id: String,
        label: String,
    },
    SurfaceRef {
        instance_id: SurfaceInstanceId,
        live: bool,
    },
    CommandRef {
        command_id: CommandId,
        label: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VibeBlockV1 {
    pub block_id: BlockId,
    pub content: VibeBlockContentV1,
}

impl Validate for VibeBlockV1 {
    fn validate(&self) -> Result<(), ContractError> {
        match &self.content {
            VibeBlockContentV1::RichText { text } | VibeBlockContentV1::Callout { text, .. } => {
                crate::validate_text(text, "vibe_block.text", MAX_VIBE_TEXT_BYTES, false, true)
            }
            VibeBlockContentV1::Divider | VibeBlockContentV1::SurfaceRef { .. } => Ok(()),
            VibeBlockContentV1::FileExcerpt {
                resource,
                start_line,
                end_line,
            } => {
                resource.validate()?;
                if start_line == &0 || start_line > end_line {
                    return Err(ContractError::InvalidValue {
                        path: "vibe_block.file_excerpt".to_string(),
                        reason: "line range must be positive and ordered".to_string(),
                    });
                }
                Ok(())
            }
            VibeBlockContentV1::ArtifactRef { artifact_id, label } => {
                crate::validate_opaque_text(artifact_id, "vibe_block.artifact_id")?;
                validate_label(label, "vibe_block.label")
            }
            VibeBlockContentV1::FindingRef { finding_id, label } => {
                crate::validate_opaque_text(finding_id, "vibe_block.finding_id")?;
                validate_label(label, "vibe_block.label")
            }
            VibeBlockContentV1::TaskRef { task_id, label } => {
                crate::validate_opaque_text(task_id, "vibe_block.task_id")?;
                validate_label(label, "vibe_block.label")
            }
            VibeBlockContentV1::CommandRef { label, .. } => {
                validate_label(label, "vibe_block.command_label")
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VibeGridPlacementV1 {
    pub block_id: BlockId,
    pub row_start: u16,
    pub column_start: u8,
    pub column_span: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum VibeSectionLayoutV1 {
    Flow,
    Grid {
        placements: Vec<VibeGridPlacementV1>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VibeSectionV1 {
    pub section_id: SectionId,
    pub heading: Option<String>,
    pub layout: VibeSectionLayoutV1,
    pub blocks: Vec<VibeBlockV1>,
}

impl Validate for VibeSectionV1 {
    fn validate(&self) -> Result<(), ContractError> {
        if let Some(heading) = &self.heading {
            validate_label(heading, "vibe_section.heading")?;
        }
        if self.blocks.len() > MAX_VIBE_BLOCKS {
            return Err(ContractError::LimitExceeded {
                path: "vibe_section.blocks".to_string(),
                limit: MAX_VIBE_BLOCKS,
                actual: self.blocks.len(),
            });
        }
        validate_unique(
            "vibe_section.blocks",
            self.blocks.iter().map(|block| block.block_id.as_ref()),
        )?;
        for block in &self.blocks {
            block.validate()?;
        }
        if let VibeSectionLayoutV1::Grid { placements } = &self.layout {
            validate_grid(&self.blocks, placements)?;
        }
        Ok(())
    }
}

fn validate_grid(
    blocks: &[VibeBlockV1],
    placements: &[VibeGridPlacementV1],
) -> Result<(), ContractError> {
    if placements.len() != blocks.len() {
        return Err(ContractError::InvalidValue {
            path: "vibe_section.layout.placements".to_string(),
            reason: "a Grid requires exactly one placement per block".to_string(),
        });
    }
    validate_unique(
        "vibe_section.layout.placements",
        placements
            .iter()
            .map(|placement| placement.block_id.as_ref()),
    )?;
    let block_ids = blocks
        .iter()
        .map(|block| block.block_id.as_str())
        .collect::<BTreeSet<_>>();
    let mut occupied = BTreeSet::new();
    for placement in placements {
        if !block_ids.contains(placement.block_id.as_str()) {
            return Err(ContractError::MissingReference {
                path: "vibe_section.layout.placements.block_id".to_string(),
                value: placement.block_id.to_string(),
            });
        }
        if placement.row_start == 0 || placement.row_start > MAX_VIBE_GRID_ROWS {
            return Err(ContractError::InvalidValue {
                path: "vibe_section.layout.placements.row_start".to_string(),
                reason: format!("row must be 1..={MAX_VIBE_GRID_ROWS}"),
            });
        }
        if placement.column_start == 0
            || placement.column_span == 0
            || placement.column_start > MAX_VIBE_GRID_COLUMNS
            || placement.column_span > MAX_VIBE_GRID_COLUMNS
            || placement.column_start + placement.column_span - 1 > MAX_VIBE_GRID_COLUMNS
        {
            return Err(ContractError::InvalidValue {
                path: "vibe_section.layout.placements.columns".to_string(),
                reason: "column start/span must fit the 12-column grid".to_string(),
            });
        }
        for column in placement.column_start..placement.column_start + placement.column_span {
            if !occupied.insert((placement.row_start, column)) {
                return Err(ContractError::InvalidValue {
                    path: "vibe_section.layout.placements".to_string(),
                    reason: format!(
                        "grid cells overlap at row {}, column {}",
                        placement.row_start, column
                    ),
                });
            }
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VibePageV1 {
    pub page_id: PageId,
    pub project_id: ProjectId,
    pub label: String,
    pub page_revision: u64,
    pub sections: Vec<VibeSectionV1>,
    pub focused_block_id: Option<BlockId>,
}

impl Validate for VibePageV1 {
    fn validate(&self) -> Result<(), ContractError> {
        validate_label(&self.label, "vibe_page.label")?;
        if self.sections.len() > MAX_VIBE_SECTIONS {
            return Err(ContractError::LimitExceeded {
                path: "vibe_page.sections".to_string(),
                limit: MAX_VIBE_SECTIONS,
                actual: self.sections.len(),
            });
        }
        validate_unique(
            "vibe_page.sections",
            self.sections
                .iter()
                .map(|section| section.section_id.as_ref()),
        )?;
        let mut block_ids = BTreeSet::new();
        let mut live_instances = BTreeMap::new();
        let mut blocks = 0;
        let mut live_surfaces = 0;
        for section in &self.sections {
            section.validate()?;
            for block in &section.blocks {
                blocks += 1;
                if blocks > MAX_VIBE_BLOCKS {
                    return Err(ContractError::LimitExceeded {
                        path: "vibe_page.blocks".to_string(),
                        limit: MAX_VIBE_BLOCKS,
                        actual: blocks,
                    });
                }
                if !block_ids.insert(block.block_id.as_str()) {
                    return Err(ContractError::Duplicate {
                        path: "vibe_page.blocks".to_string(),
                        value: block.block_id.to_string(),
                    });
                }
                if let VibeBlockContentV1::SurfaceRef {
                    instance_id,
                    live: true,
                } = &block.content
                {
                    live_surfaces += 1;
                    if live_surfaces > MAX_VIBE_LIVE_SURFACES {
                        return Err(ContractError::LimitExceeded {
                            path: "vibe_page.live_surfaces".to_string(),
                            limit: MAX_VIBE_LIVE_SURFACES,
                            actual: live_surfaces,
                        });
                    }
                    if live_instances
                        .insert(instance_id.as_str(), block.block_id.as_str())
                        .is_some()
                    {
                        return Err(ContractError::Duplicate {
                            path: "vibe_page.live_surface_instances".to_string(),
                            value: instance_id.to_string(),
                        });
                    }
                }
            }
        }
        if let Some(focused) = &self.focused_block_id
            && !block_ids.contains(focused.as_str())
        {
            return Err(ContractError::MissingReference {
                path: "vibe_page.focused_block_id".to_string(),
                value: focused.to_string(),
            });
        }
        let encoded = encoded_json_len("vibe_page", self)?;
        if encoded > MAX_VIBE_PAGE_JSON_BYTES {
            return Err(ContractError::LimitExceeded {
                path: "vibe_page.encoded_bytes".to_string(),
                limit: MAX_VIBE_PAGE_JSON_BYTES,
                actual: encoded,
            });
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum VibePageMutationV1 {
    ReplaceSections {
        sections: Vec<VibeSectionV1>,
    },
    SetFocus {
        block_id: Option<BlockId>,
    },
    UpdateBlock {
        block_id: BlockId,
        replacement: VibeBlockV1,
    },
}

pub fn apply_vibe_page_mutation(
    page: &VibePageV1,
    expected_revision: u64,
    mutation: VibePageMutationV1,
) -> Result<VibePageV1, ContractError> {
    ensure_revision(
        "vibe_page.page_revision",
        expected_revision,
        page.page_revision,
    )?;
    let mut next = page.clone();
    match mutation {
        VibePageMutationV1::ReplaceSections { sections } => next.sections = sections,
        VibePageMutationV1::SetFocus { block_id } => next.focused_block_id = block_id,
        VibePageMutationV1::UpdateBlock {
            block_id,
            replacement,
        } => {
            if replacement.block_id != block_id {
                return Err(ContractError::InvalidValue {
                    path: "vibe_page_mutation.replacement.block_id".to_string(),
                    reason: "replacement must retain the target block identity".to_string(),
                });
            }
            let mut found = false;
            for section in &mut next.sections {
                if let Some(block) = section
                    .blocks
                    .iter_mut()
                    .find(|block| block.block_id == block_id)
                {
                    *block = replacement.clone();
                    found = true;
                    break;
                }
            }
            if !found {
                return Err(ContractError::MissingReference {
                    path: "vibe_page_mutation.block_id".to_string(),
                    value: block_id.to_string(),
                });
            }
        }
    }
    next.page_revision = next_revision("vibe_page.page_revision", expected_revision)?;
    next.validate()?;
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block(id: &str, text: &str) -> VibeBlockV1 {
        VibeBlockV1 {
            block_id: BlockId::new(id).unwrap(),
            content: VibeBlockContentV1::RichText {
                text: text.to_string(),
            },
        }
    }

    fn page() -> VibePageV1 {
        VibePageV1 {
            page_id: PageId::new("page:review").unwrap(),
            project_id: ProjectId::new("project:a").unwrap(),
            label: "Project review".to_string(),
            page_revision: 3,
            sections: vec![VibeSectionV1 {
                section_id: SectionId::new("section:summary").unwrap(),
                heading: Some("Summary".to_string()),
                layout: VibeSectionLayoutV1::Grid {
                    placements: vec![
                        VibeGridPlacementV1 {
                            block_id: BlockId::new("block:text").unwrap(),
                            row_start: 1,
                            column_start: 1,
                            column_span: 5,
                        },
                        VibeGridPlacementV1 {
                            block_id: BlockId::new("block:surface").unwrap(),
                            row_start: 1,
                            column_start: 6,
                            column_span: 7,
                        },
                    ],
                },
                blocks: vec![
                    block("block:text", "Review notes"),
                    VibeBlockV1 {
                        block_id: BlockId::new("block:surface").unwrap(),
                        content: VibeBlockContentV1::SurfaceRef {
                            instance_id: SurfaceInstanceId::new("instance:check").unwrap(),
                            live: true,
                        },
                    },
                ],
            }],
            focused_block_id: Some(BlockId::new("block:text").unwrap()),
        }
    }

    #[test]
    fn ordered_grid_page_is_valid() {
        page().validate().unwrap();
    }

    #[test]
    fn empty_vibe_page_and_empty_flow_section_are_valid_authoring_states() {
        let mut empty = page();
        empty.sections.clear();
        empty.focused_block_id = None;
        empty.validate().unwrap();

        empty.sections.push(VibeSectionV1 {
            section_id: SectionId::new("section:empty").unwrap(),
            heading: None,
            layout: VibeSectionLayoutV1::Flow,
            blocks: vec![],
        });
        empty.validate().unwrap();
    }

    #[test]
    fn overlapping_grid_cells_are_rejected() {
        let mut page = page();
        let VibeSectionLayoutV1::Grid { placements } = &mut page.sections[0].layout else {
            panic!("fixture grid")
        };
        placements[1].column_start = 5;
        assert!(page.validate().is_err());
    }

    #[test]
    fn same_live_instance_cannot_be_mounted_twice() {
        let mut page = page();
        let duplicate = VibeBlockV1 {
            block_id: BlockId::new("block:duplicate").unwrap(),
            content: VibeBlockContentV1::SurfaceRef {
                instance_id: SurfaceInstanceId::new("instance:check").unwrap(),
                live: true,
            },
        };
        page.sections.push(VibeSectionV1 {
            section_id: SectionId::new("section:duplicate").unwrap(),
            heading: None,
            layout: VibeSectionLayoutV1::Flow,
            blocks: vec![duplicate],
        });
        assert!(matches!(
            page.validate(),
            Err(ContractError::Duplicate { .. })
        ));
    }

    #[test]
    fn page_mutations_reject_stale_and_missing_targets() {
        let page = page();
        assert!(matches!(
            apply_vibe_page_mutation(&page, 2, VibePageMutationV1::SetFocus { block_id: None }),
            Err(ContractError::StaleRevision { .. })
        ));
        assert!(
            apply_vibe_page_mutation(
                &page,
                3,
                VibePageMutationV1::SetFocus {
                    block_id: Some(BlockId::new("block:missing").unwrap())
                }
            )
            .is_err()
        );
        assert_eq!(page.page_revision, 3);
    }

    #[test]
    fn page_byte_budget_uses_payload_shape_not_pathological_item_count() {
        let mut page = page();
        page.sections[0].blocks[0] = block("block:text", &"x".repeat(MAX_VIBE_TEXT_BYTES));
        page.validate().unwrap();
        page.sections[0].blocks[0] = block("block:text", &"x".repeat(MAX_VIBE_TEXT_BYTES + 1));
        assert!(page.validate().is_err());
    }

    #[test]
    fn page_encoded_byte_budget_rejects_large_but_individually_valid_blocks() {
        let mut page = page();
        let blocks = (0..17)
            .map(|index| {
                block(
                    &format!("block:large-{index}"),
                    &"x".repeat(MAX_VIBE_TEXT_BYTES),
                )
            })
            .collect::<Vec<_>>();
        page.sections = vec![VibeSectionV1 {
            section_id: SectionId::new("section:large").unwrap(),
            heading: None,
            layout: VibeSectionLayoutV1::Flow,
            blocks,
        }];
        page.focused_block_id = None;
        assert!(matches!(
            page.validate(),
            Err(ContractError::LimitExceeded { path, .. }) if path == "vibe_page.encoded_bytes"
        ));
    }
}
