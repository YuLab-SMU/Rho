use crate::PlanArguments;

impl PlanArguments {
    pub fn validate(&self) -> Result<(), String> {
        match self {
            Self::Pak { packages }
                if packages.is_empty()
                    || packages.len() > 128
                    || packages.iter().any(|value| {
                        value.is_empty()
                            || value.len() > 2048
                            || value.chars().any(char::is_control)
                    }) =>
            {
                Err("pak plan requires 1..=128 bounded package references".into())
            }
            Self::Renv { lockfile }
                if lockfile.is_empty()
                    || lockfile.len() > 1024
                    || lockfile.chars().any(char::is_control) =>
            {
                Err("renv plan requires a bounded lockfile path".into())
            }
            _ => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn plan_inputs_bound_native_arguments_without_rewriting_unicode() {
        assert!(
            PlanArguments::Pak {
                packages: vec!["local::数据包".into()]
            }
            .validate()
            .is_ok()
        );
        for packages in [
            vec![],
            vec!["x".repeat(2049)],
            vec!["local::pkg\n".into()],
            vec!["x".into(); 129],
        ] {
            assert!(PlanArguments::Pak { packages }.validate().is_err());
        }
        for lockfile in ["".into(), "x".repeat(1025), "renv\0.lock".into()] {
            assert!(PlanArguments::Renv { lockfile }.validate().is_err());
        }
        assert!(
            PlanArguments::Renv {
                lockfile: "环境/renv.lock".into()
            }
            .validate()
            .is_ok()
        );
    }
}
