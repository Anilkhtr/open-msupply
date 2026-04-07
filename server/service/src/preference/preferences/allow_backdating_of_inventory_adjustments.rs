use crate::preference::{PrefKey, Preference, PreferenceType, PreferenceValueType};

pub struct AllowBackdatingOfInventoryAdjustments;

impl Preference for AllowBackdatingOfInventoryAdjustments {
    type Value = bool;

    fn key(&self) -> PrefKey {
        PrefKey::AllowBackdatingOfInventoryAdjustments
    }

    fn preference_type(&self) -> PreferenceType {
        PreferenceType::Global
    }

    fn value_type(&self) -> PreferenceValueType {
        PreferenceValueType::Boolean
    }
}
