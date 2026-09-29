//! Temporary fixed-composition store adapter; all annotation tables and transactions
//! belong to the plugin's separate database. Delete this adapter with ApplicationStore.
use crate::ApplicationStore;
use rho_annotation_api::*;
use rho_annotation_owner::*;
impl AnnotationRepository for ApplicationStore {
    fn annotation_receipt(
        &self,
        scope: &AnnotationScope,
        request_id: &str,
    ) -> Result<Option<StoredAnnotationReceipt>, AnnotationError> {
        self.2.annotation_receipt(scope, request_id)
    }
    fn annotation_evidence(
        &self,
        scope: &AnnotationScope,
        evidence_id: &str,
    ) -> Result<Option<AnnotationEvidence>, AnnotationError> {
        self.2.annotation_evidence(scope, evidence_id)
    }
    fn annotation_capture(
        &self,
        scope: &AnnotationScope,
        capture_id: &str,
    ) -> Result<Option<(AnnotationCaptureRef, Vec<u8>)>, AnnotationError> {
        self.2.annotation_capture(scope, capture_id)
    }
    fn annotation_head(
        &self,
        scope: &AnnotationScope,
        annotation_id: &str,
    ) -> Result<Option<AnnotationRevision>, AnnotationError> {
        self.2.annotation_head(scope, annotation_id)
    }
    fn annotation_revision(
        &self,
        scope: &AnnotationScope,
        reference: &AnnotationRevisionRef,
    ) -> Result<Option<AnnotationRevision>, AnnotationError> {
        self.2.annotation_revision(scope, reference)
    }
    fn annotation_list(
        &self,
        scope: &AnnotationScope,
        source_id: Option<&str>,
        after: Option<&str>,
        limit: u32,
        include_deleted: bool,
    ) -> Result<(Vec<AnnotationListItem>, Option<String>), AnnotationError> {
        self.2
            .annotation_list(scope, source_id, after, limit, include_deleted)
    }
    fn commit_annotation(
        &self,
        scope: &AnnotationScope,
        request_id: &str,
        input_digest: &str,
        write: AnnotationWrite<'_>,
        receipt: &AnnotationCommandReceipt,
    ) -> Result<AnnotationCommandReceipt, AnnotationError> {
        self.2
            .commit_annotation(scope, request_id, input_digest, write, receipt)
    }
}
