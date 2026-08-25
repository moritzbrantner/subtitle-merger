use native_whisperx::{
    NativeOpusMtTranslationProvider, NativeOpusMtTranslationProviderConfig, TranslationPlan,
    TranslationPlanProvenance,
};

#[test]
fn plans_direct_and_pivot_translation_without_loading_models() {
    let direct = TranslationPlan::from_language_codes("de", "es").expect("direct plan");
    assert!(matches!(
        direct.provenance(),
        TranslationPlanProvenance::Direct
    ));

    let pivot = TranslationPlan::from_language_codes("pt", "nl").expect("pivot plan");
    assert!(matches!(
        pivot.provenance(),
        TranslationPlanProvenance::PivotTranslation { .. }
    ));
}

#[test]
fn native_translation_provider_is_lazy_to_construct() {
    let _provider = NativeOpusMtTranslationProvider::new(NativeOpusMtTranslationProviderConfig {
        model_cache_only: true,
        ..Default::default()
    });
}
