import { useEffect, useRef, useState } from "react";
import { askApi, fileToBase64, formatSize, type AskConversation, type AskDocument, type Project } from "../../ask/api";
import { isImage, isPdf, isText } from "../../ask/context";
import { BackButton, NavBar, NavButton, Spinner, relativeTime } from "../../ui/common";
import { Icon } from "../../ui/Icon";
import { Sheet } from "../../ui/Sheet";
import { SwipeRow } from "../Home";
import { NameSheet, ProjectTile } from "./AskHome";

const MAX_BYTES = 10 * 1024 * 1024;

function docKind(doc: AskDocument): string {
  if (isPdf(doc)) return "PDF";
  if (isImage(doc)) return "Image";
  if (isText(doc)) return doc.name.split(".").pop()?.toUpperCase() || "Texte";
  return "Fichier";
}

export function AskProject({ projectId, active, onBack, onOpenChat, onError }: {
  projectId: string;
  active: boolean;
  onBack(): void;
  onOpenChat(id: string | null, projectId: string): void;
  onError(err: unknown): void;
}) {
  const [project, setProject] = useState<Project | null>(null);
  const [documents, setDocuments] = useState<AskDocument[]>([]);
  const [conversations, setConversations] = useState<AskConversation[]>([]);
  const [uploading, setUploading] = useState<string[]>([]);
  const [scrolled, setScrolled] = useState(false);
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [editing, setEditing] = useState(false);
  const [instructions, setInstructions] = useState("");
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!active) return;
    askApi
      .project(projectId)
      .then((d) => {
        setProject(d.project);
        setDocuments(d.documents);
        setConversations(d.conversations);
      })
      .catch(onError);
  }, [active, projectId]);

  async function addFiles(files: FileList | null) {
    for (const file of [...(files ?? [])]) {
      if (file.size > MAX_BYTES) {
        onError(new Error(`${file.name} dépasse 10 Mo.`));
        continue;
      }
      setUploading((u) => [...u, file.name]);
      try {
        const doc = await askApi.uploadDocument(
          { projectId },
          { name: file.name, mediaType: file.type || "application/octet-stream", base64: await fileToBase64(file) },
        );
        setDocuments((d) => [doc, ...d]);
      } catch (err) {
        onError(err);
      }
      setUploading((u) => u.filter((n) => n !== file.name));
    }
  }

  async function saveInstructions() {
    try {
      setProject(await askApi.updateProject(projectId, { instructions }));
      setEditing(false);
    } catch (err) {
      onError(err);
    }
  }

  const name = project?.name ?? "";
  return (
    <div className="screen">
      <NavBar
        title={name}
        showTitle={scrolled}
        left={<BackButton label="Conversations" onClick={onBack} />}
        right={<NavButton icon="more" label="Actions" onClick={() => setMenu(true)} disabled={!project} />}
      />
      <div className="scroll" onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 40)}>
        {!project ? (
          <div className="empty">
            <Spinner />
          </div>
        ) : (
          <>
            <div className="ask-hero">
              <ProjectTile name={name} index={0} size={56} />
              <h1 className="large-title">{name}</h1>
            </div>

            <button
              type="button"
              className="ask-instructions"
              onClick={() => {
                setInstructions(project.instructions);
                setEditing(true);
              }}
            >
              <span className="ask-instructions__head">
                <Icon name="pencil" size={14} /> Instructions
              </span>
              <span className="ask-instructions__body" data-empty={!project.instructions || undefined}>
                {project.instructions || "Dis à Claake comment travailler sur ce projet : ton, contexte, objectifs…"}
              </span>
            </button>

            <section className="group">
              <h2 className="group__title">Documents</h2>
              <div className="group__body">
                {documents.map((doc) => (
                  <SwipeRow
                    key={doc.id}
                    onDelete={() => {
                      setDocuments((d) => d.filter((x) => x.id !== doc.id));
                      void askApi.deleteDocument(doc.id).catch(onError);
                    }}
                  >
                    <div className="row row--static">
                      <span className="row__icon" data-tone={isImage(doc) ? "mode" : "folder"}>
                        <Icon name={isImage(doc) ? "photo" : "doc"} size={18} />
                      </span>
                      <span className="row__text">
                        <strong>{doc.name}</strong>
                        <span>
                          {docKind(doc)} · {formatSize(doc.size)}
                        </span>
                      </span>
                    </div>
                  </SwipeRow>
                ))}
                {uploading.map((n) => (
                  <div key={n} className="row row--static">
                    <span className="row__icon" data-tone="off"><Spinner size={16} /></span>
                    <span className="row__text">
                      <strong>{n}</strong>
                      <span>Envoi…</span>
                    </span>
                  </div>
                ))}
                <button type="button" className="row row--compact ask-add" onClick={() => picker.current?.click()}>
                  <Icon name="plus" size={18} stroke={2.2} />
                  <span>Ajouter un document</span>
                </button>
              </div>
              <p className="group__footer">PDF, images, texte, Markdown et code, 10 Mo maximum. Claake les lit à chaque message du projet.</p>
            </section>

            <section className="group">
              <h2 className="group__title">Conversations</h2>
              <div className="group__body">
                <button type="button" className="row row--compact ask-add" onClick={() => onOpenChat(null, projectId)}>
                  <Icon name="plus" size={18} stroke={2.2} />
                  <span>Nouvelle conversation</span>
                </button>
                {conversations.map((c) => (
                  <SwipeRow
                    key={c.id}
                    onDelete={() => {
                      setConversations((list) => list.filter((x) => x.id !== c.id));
                      void askApi.deleteConversation(c.id).catch(onError);
                    }}
                  >
                    <button type="button" className="row" onClick={() => onOpenChat(c.id, projectId)}>
                      <span className="row__icon" data-tone="chat">
                        <Icon name="bubble" size={18} />
                      </span>
                      <span className="row__text">
                        <strong>{c.title}</strong>
                        <span>{relativeTime(c.updatedAtMs)}</span>
                      </span>
                      <span className="row__chevron"><Icon name="chevron" size={16} /></span>
                    </button>
                  </SwipeRow>
                ))}
              </div>
            </section>
          </>
        )}
      </div>
      <input ref={picker} type="file" multiple hidden onChange={(e) => void addFiles(e.target.files).then(() => (e.target.value = ""))} />

      <Sheet open={editing} title="Instructions" onClose={() => setEditing(false)}>
        <form
          className="ask-form"
          onSubmit={(e) => {
            e.preventDefault();
            void saveInstructions();
          }}
        >
          <textarea
            className="ask-input ask-input--area"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="Exemple : tu m'aides à rédiger mon mémoire, cite toujours le document utilisé."
            rows={8}
            maxLength={20000}
          />
          <button type="submit" className="button button--primary button--wide">Enregistrer</button>
        </form>
      </Sheet>

      <Sheet open={menu} title={name} onClose={() => setMenu(false)}>
        <div className="group__body">
          <button
            type="button"
            className="row"
            onClick={() => {
              setMenu(false);
              setRenaming(true);
            }}
          >
            <span className="row__icon" data-tone="mode"><Icon name="pencil" size={18} /></span>
            <span className="row__text"><strong>Renommer</strong></span>
          </button>
          <button
            type="button"
            className="row row--danger"
            onClick={async () => {
              if (!window.confirm(`Supprimer « ${name} », ses conversations et ses documents ?`)) return;
              setMenu(false);
              try {
                await askApi.deleteProject(projectId);
                onBack();
              } catch (err) {
                onError(err);
              }
            }}
          >
            <span className="row__icon" data-tone="danger"><Icon name="trash" size={18} /></span>
            <span className="row__text"><strong>Supprimer le projet</strong></span>
          </button>
        </div>
      </Sheet>

      <NameSheet
        open={renaming}
        title="Renommer le projet"
        action="Renommer"
        initial={name}
        onClose={() => setRenaming(false)}
        onSubmit={async (next) => {
          try {
            setProject(await askApi.updateProject(projectId, { name: next }));
            setRenaming(false);
          } catch (err) {
            onError(err);
          }
        }}
      />
    </div>
  );
}
