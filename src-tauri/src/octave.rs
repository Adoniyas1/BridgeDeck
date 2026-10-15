//! Making GNU Octave run more MATLAB code: fill-ins for MATLAB functions Octave doesn't have
//! (octave_compat/*.m, put last on Octave's path so a newer Octave's own versions win), and the
//! Octave packages (control, signal, statistics, symbolic) a program needs, loaded before it runs.

/// The fill-in functions, written next to each program in `bridgedeck_compat/`.
pub const FILL_INS: &[(&str, &str)] = &[
    ("bridgedeck_workspace.m", include_str!("octave_compat/bridgedeck_workspace.m")),
    ("compose.m", include_str!("octave_compat/compose.m")),
    ("contains.m", include_str!("octave_compat/contains.m")),
    ("convertStringsToChars.m", include_str!("octave_compat/convertStringsToChars.m")),
    ("exportgraphics.m", include_str!("octave_compat/exportgraphics.m")),
    ("extractAfter.m", include_str!("octave_compat/extractAfter.m")),
    ("extractBefore.m", include_str!("octave_compat/extractBefore.m")),
    ("extractBetween.m", include_str!("octave_compat/extractBetween.m")),
    ("height.m", include_str!("octave_compat/height.m")),
    ("histcounts.m", include_str!("octave_compat/histcounts.m")),
    ("histogram.m", include_str!("octave_compat/histogram.m")),
    ("join.m", include_str!("octave_compat/join.m")),
    ("nexttile.m", include_str!("octave_compat/nexttile.m")),
    ("normcdf.m", include_str!("octave_compat/normcdf.m")),
    ("normpdf.m", include_str!("octave_compat/normpdf.m")),
    ("normrnd.m", include_str!("octave_compat/normrnd.m")),
    ("pad.m", include_str!("octave_compat/pad.m")),
    ("readmatrix.m", include_str!("octave_compat/readmatrix.m")),
    ("replace.m", include_str!("octave_compat/replace.m")),
    ("sgtitle.m", include_str!("octave_compat/sgtitle.m")),
    ("split.m", include_str!("octave_compat/split.m")),
    ("string.m", include_str!("octave_compat/string.m")),
    ("strings.m", include_str!("octave_compat/strings.m")),
    ("strip.m", include_str!("octave_compat/strip.m")),
    ("strlength.m", include_str!("octave_compat/strlength.m")),
    ("tiledlayout.m", include_str!("octave_compat/tiledlayout.m")),
    ("width.m", include_str!("octave_compat/width.m")),
    ("writematrix.m", include_str!("octave_compat/writematrix.m")),
    ("xline.m", include_str!("octave_compat/xline.m")),
    ("yline.m", include_str!("octave_compat/yline.m")),
];

/// Functions that come from Octave's packages (MATLAB's toolboxes), by package.
const PACKAGES: &[(&str, &[&str])] = &[
    ("control", &["tf", "ss", "zpk", "bode", "bodemag", "step", "impulse", "initial", "lsim", "feedback", "rlocus", "pzmap", "nyquist", "nichols", "margin", "c2d", "d2c", "pole", "zero", "dcgain", "ctrb", "obsv", "lqr", "place", "damp", "minreal", "tfdata", "ssdata", "stepinfo", "series", "parallel"]),
    ("signal", &["butter", "buttord", "cheby1", "cheby2", "ellip", "filtfilt", "fir1", "fir2", "freqz", "impz", "zplane", "periodogram", "pwelch", "spectrogram", "xcorr", "resample", "decimate", "sawtooth", "square", "chirp", "findpeaks", "medfilt1", "upsample", "downsample", "bilinear", "tripuls", "rectpuls", "gauspuls"]),
    ("statistics", &["normfit", "ttest", "ttest2", "anova1", "boxplot", "tinv", "tcdf", "chi2inv", "chi2cdf", "fitlm", "regress", "binopdf", "binornd", "binocdf", "poisspdf", "poissrnd", "unifrnd", "exprnd", "mvnrnd", "histfit", "kstest", "ranksum", "signrank", "norminv", "makedist", "fitdist"]),
    ("symbolic", &["syms", "sym", "vpa", "simplify", "dsolve", "laplace", "ilaplace", "ztrans", "iztrans", "subs", "limit", "taylor", "matlabFunction", "fourier"]),
];

/// The code of a MATLAB program without its comments and text in quotes (roughly: enough to find
/// the names it calls).
fn code_only(source: &str) -> String {
    let mut out = String::new();
    for line in source.lines() {
        let mut prev = ' ';
        let mut quote: Option<char> = None;
        for c in line.chars() {
            match quote {
                Some(q) if c == q => quote = None,
                Some(_) => {}
                None if c == '%' || c == '#' => break,
                None if c == '"' || (c == '\'' && !(prev.is_alphanumeric() || matches!(prev, '_' | ')' | ']' | '}' | '.' | '\''))) => quote = Some(c),
                None => out.push(c),
            }
            if quote.is_none() || c == '\'' || c == '"' {
                prev = c;
            }
        }
        out.push('\n');
    }
    out
}

/// The Octave packages a program needs, from the functions it calls.
pub fn packages_for(source: &str) -> Vec<&'static str> {
    let code = code_only(source);
    let words: std::collections::HashSet<&str> = code.split(|c: char| !(c.is_alphanumeric() || c == '_')).filter(|w| !w.is_empty()).collect();
    PACKAGES.iter().filter(|(_, names)| names.iter().any(|n| words.contains(n))).map(|(p, _)| *p).collect()
}

pub fn is_package(name: &str) -> bool {
    PACKAGES.iter().any(|(p, _)| *p == name)
}

/// The lines put before the program: the fill-ins (last on the path) and its packages, each
/// loaded if it's installed and named (with how to get it) if it isn't.
pub fn prelude(source: &str) -> String {
    let mut out = String::from("addpath(fullfile(pwd, 'bridgedeck_compat'), '-end');\n");
    for p in packages_for(source) {
        out.push_str(&format!(
            "try\n  pkg load {p};\ncatch\n  fprintf(2, 'BridgeDeck: this program uses Octave''s {p} package (MATLAB''s toolbox), which isn''t installed here. Install it with the button below.\\n');\nend\n"
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_packages_a_program_calls_but_not_in_comments_or_text() {
        assert_eq!(packages_for("G = tf([1], [1 2 1]);\nstep(G)"), vec!["control"]);
        assert_eq!(packages_for("[b, a] = butter(4, 0.2);\ny = filtfilt(b, a, x);\nsyms t"), vec!["signal", "symbolic"]);
        assert!(packages_for("% step(G) in a comment\ndisp('tf(1) in text')\nx = steps + 1;").is_empty());
        assert_eq!(packages_for("y = x'; z = step(sys);"), vec!["control"]);
        assert!(is_package("signal") && !is_package("../evil"));
        assert!(prelude("bode(G)").contains("pkg load control"));
        assert!(FILL_INS.iter().any(|(n, body)| *n == "contains.m" && body.contains("function tf = contains")));
    }
}
