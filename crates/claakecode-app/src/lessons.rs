use anyhow::{bail, Context, Result};
use rusqlite::{params, Row};
use uuid::Uuid;

use crate::store::AppStore;

const STATUSES: [&str; 3] = ["candidate", "validated", "rejected"];
const PROMPT_MAX_CHARS: usize = 4_000;
const PROMPT_MAX_LESSONS: usize = 20;

#[derive(Debug, Clone, PartialEq)]
pub struct Lesson {
    pub id: String,
    pub title: String,
    pub content: String,
    pub status: String,
    pub source_kind: String,
    pub evidence: String,
    pub tags: Vec<String>,
    pub run_id: Option<String>,
    pub conversation_id: Option<String>,
    pub score_without: Option<f64>,
    pub score_with: Option<f64>,
    pub bench_runs: u32,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, Default)]
pub struct NewLesson {
    pub title: String,
    pub content: String,
    pub source_kind: String,
    pub evidence: String,
    pub tags: Vec<String>,
    pub run_id: Option<String>,
    pub conversation_id: Option<String>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn truncate(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

const COLUMNS: &str = "id, title, content, status, source_kind, evidence, tags_json, run_id, conversation_id, score_without, score_with, bench_runs, created_at_ms, updated_at_ms";

fn row_to_lesson(row: &Row<'_>) -> rusqlite::Result<Lesson> {
    let tags_json: String = row.get(6)?;
    Ok(Lesson {
        id: row.get(0)?,
        title: row.get(1)?,
        content: row.get(2)?,
        status: row.get(3)?,
        source_kind: row.get(4)?,
        evidence: row.get(5)?,
        tags: serde_json::from_str(&tags_json).unwrap_or_default(),
        run_id: row.get(7)?,
        conversation_id: row.get(8)?,
        score_without: row.get(9)?,
        score_with: row.get(10)?,
        bench_runs: row.get::<_, i64>(11)?.max(0) as u32,
        created_at_ms: row.get(12)?,
        updated_at_ms: row.get(13)?,
    })
}

impl AppStore {
    pub fn insert_lesson(&self, new: NewLesson) -> Result<Lesson> {
        let title = truncate(new.title.trim(), 200);
        let content = truncate(new.content.trim(), 2_000);
        let evidence = truncate(new.evidence.trim(), 2_000);
        if title.is_empty() || content.is_empty() {
            bail!("lesson title and content are required");
        }
        if evidence.is_empty() {
            bail!("lesson evidence is required");
        }
        let conn = self.connection()?;
        let duplicate: i64 = conn.query_row(
            "select count(*) from lessons where title = ?1 and content = ?2",
            params![title, content],
            |row| row.get(0),
        )?;
        if duplicate > 0 {
            bail!("duplicate lesson");
        }
        let now = now_ms();
        let id = Uuid::new_v4().to_string();
        conn.execute(
            "insert into lessons (id, title, content, status, source_kind, evidence, tags_json, run_id, conversation_id, bench_runs, created_at_ms, updated_at_ms)
             values (?1, ?2, ?3, 'candidate', ?4, ?5, ?6, ?7, ?8, 0, ?9, ?9)",
            params![
                id,
                title,
                content,
                new.source_kind,
                evidence,
                serde_json::to_string(&new.tags)?,
                new.run_id,
                new.conversation_id,
                now
            ],
        )
        .context("unable to insert lesson")?;
        Ok(Lesson {
            id,
            title,
            content,
            status: "candidate".into(),
            source_kind: new.source_kind,
            evidence,
            tags: new.tags,
            run_id: new.run_id,
            conversation_id: new.conversation_id,
            score_without: None,
            score_with: None,
            bench_runs: 0,
            created_at_ms: now,
            updated_at_ms: now,
        })
    }

    /// Newest first.
    pub fn list_lessons(&self, status: Option<&str>) -> Result<Vec<Lesson>> {
        let conn = self.connection()?;
        let mut stmt = conn.prepare(&format!(
            "select {COLUMNS} from lessons where (?1 is null or status = ?1) order by created_at_ms desc, rowid desc"
        ))?;
        let rows = stmt.query_map(params![status], row_to_lesson)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn set_lesson_status(
        &self,
        id: &str,
        status: &str,
        score_without: Option<f64>,
        score_with: Option<f64>,
        bench_runs: u32,
    ) -> Result<()> {
        if !STATUSES.contains(&status) {
            bail!("invalid lesson status: {status}");
        }
        self.connection()?.execute(
            "update lessons set status = ?2, score_without = ?3, score_with = ?4, bench_runs = ?5, updated_at_ms = ?6 where id = ?1",
            params![id, status, score_without, score_with, bench_runs as i64, now_ms()],
        )?;
        Ok(())
    }

    pub fn update_lesson_text(&self, id: &str, title: &str, content: &str) -> Result<()> {
        self.connection()?.execute(
            "update lessons set title = ?2, content = ?3, updated_at_ms = ?4 where id = ?1",
            params![id, truncate(title.trim(), 200), truncate(content.trim(), 2_000), now_ms()],
        )?;
        Ok(())
    }

    pub fn delete_lesson(&self, id: &str) -> Result<()> {
        self.connection()?.execute("delete from lessons where id = ?1", params![id])?;
        Ok(())
    }

    pub fn clear_lessons(&self) -> Result<()> {
        self.connection()?.execute("delete from lessons", [])?;
        Ok(())
    }

    /// Prompt block for a conversation: all validated lessons plus its own candidates.
    pub fn lessons_prompt_for(&self, conversation_id: &str) -> Option<String> {
        let validated = self.list_lessons(Some("validated")).ok()?;
        let candidates: Vec<Lesson> = self
            .list_lessons(Some("candidate"))
            .ok()?
            .into_iter()
            .filter(|l| l.conversation_id.as_deref() == Some(conversation_id))
            .collect();
        lessons_prompt_block(&validated, &candidates)
    }
}

/// Validated lessons (20 newest, 4000 chars max), then this conversation's unverified candidates.
/// Rejected lessons are never rendered, whatever the caller passes.
pub fn lessons_prompt_block(validated: &[Lesson], local_candidates: &[Lesson]) -> Option<String> {
    let render = |lessons: &[Lesson], status: &str, limit: usize| -> String {
        let mut body = String::new();
        for l in lessons.iter().filter(|l| l.status == status).take(limit) {
            let line = format!("- {}: {}\n", l.title, l.content);
            if body.chars().count() + line.chars().count() > PROMPT_MAX_CHARS {
                break;
            }
            body.push_str(&line);
        }
        body
    };
    let validated = render(validated, "validated", PROMPT_MAX_LESSONS);
    let candidates = render(local_candidates, "candidate", PROMPT_MAX_LESSONS);
    let mut out = String::new();
    if !validated.is_empty() {
        out.push_str(&format!("<validated_lessons>\n{validated}</validated_lessons>"));
    }
    if !candidates.is_empty() {
        if !out.is_empty() {
            out.push_str("\n\n");
        }
        out.push_str(&format!(
            "<candidate_lessons note=\"unverified, this conversation only\">\n{candidates}</candidate_lessons>"
        ));
    }
    (!out.is_empty()).then_some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn new(title: &str, evidence: &str) -> NewLesson {
        NewLesson {
            title: title.into(),
            content: "content".into(),
            source_kind: "user".into(),
            evidence: evidence.into(),
            conversation_id: Some("c1".into()),
            ..Default::default()
        }
    }

    #[test]
    fn lesson_lifecycle_and_prompt_block() -> Result<()> {
        let store = AppStore::in_memory()?;
        let a = store.insert_lesson(new("a", "proof"))?;
        assert_eq!(a.status, "candidate");
        assert!(store.insert_lesson(new("b", "  ")).is_err());
        assert!(store.insert_lesson(new("a", "other proof")).is_err());
        assert!(store.set_lesson_status(&a.id, "bogus", None, None, 0).is_err());

        store.set_lesson_status(&a.id, "validated", Some(0.2), Some(0.8), 3)?;
        let validated = store.list_lessons(Some("validated"))?;
        assert_eq!(validated.len(), 1);
        assert_eq!(validated[0].score_with, Some(0.8));
        assert!(store.list_lessons(Some("candidate"))?.is_empty());

        let rejected = store.insert_lesson(new("r", "proof"))?;
        store.set_lesson_status(&rejected.id, "rejected", None, None, 1)?;
        let all = store.list_lessons(None)?;
        let block = lessons_prompt_block(&all, &[]).unwrap();
        assert!(block.contains("- a: content") && !block.contains("- r:"));
        assert!(lessons_prompt_block(&[], &[]).is_none());

        let local = store.insert_lesson(new("local", "proof"))?;
        let with_local = store.lessons_prompt_for("c1").unwrap();
        assert!(with_local.contains("<candidate_lessons") && with_local.contains("- local:"));
        assert!(!store.lessons_prompt_for("c2").unwrap().contains("- local:"));
        store.delete_lesson(&local.id)?;
        store.clear_lessons()?;
        assert!(store.list_lessons(None)?.is_empty());
        Ok(())
    }

    #[test]
    fn prompt_block_respects_char_limit() {
        let lesson = |i: usize| Lesson {
            id: i.to_string(),
            title: format!("t{i}"),
            content: "x".repeat(1_000),
            status: "validated".into(),
            source_kind: "user".into(),
            evidence: "e".into(),
            tags: vec![],
            run_id: None,
            conversation_id: None,
            score_without: None,
            score_with: None,
            bench_runs: 0,
            created_at_ms: 0,
            updated_at_ms: 0,
        };
        let many: Vec<Lesson> = (0..10).map(lesson).collect();
        let block = lessons_prompt_block(&many, &[]).unwrap();
        assert!(block.chars().count() < 4_000 + 60);
        assert!(block.contains("- t2:") && !block.contains("- t3:"));
    }
}
