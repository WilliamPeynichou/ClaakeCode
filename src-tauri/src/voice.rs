//! Voice mode: note appended to a turn when the user directs the agent by voice.

pub(crate) const VOICE_TURN_NOTE: &str = "[Claake voice mode: the user is directing you by voice, like a lead talking to their developer. Do the task fully as usual and keep your normal written answer. At the very end of your final answer, add one spoken report inside <spoken>...</spoken>: 2 to 4 short sentences in the user's language saying what you did, the state (tests, build), any blocker, and what you need from the user. Inside it: no code, no paths, no markdown, no lists; name files by their short name; if you need a decision, ask one question with numbered options. Never write <spoken> anywhere else.]";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn note_asks_for_one_spoken_block() {
        assert!(VOICE_TURN_NOTE.contains("<spoken>...</spoken>"));
        assert!(VOICE_TURN_NOTE.starts_with('[') && VOICE_TURN_NOTE.ends_with(']'));
    }
}
