import app from "./app";
import { readSessionMember, type AuthMember } from "./auth";
import { recipeEditorPage } from "./recipe-editor-page";
import { updateRecipeFromDraft, validateRecipeEdit } from "./recipe-editor";
import { deleteRecipe } from "./recipes";

interface Env {
  DB: D1Database;
  DEV_MEMBER_ID?: string;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_MODEL?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  SESSION_SECRET?: string;
}

async function memberFor(request: Request, env: Env): Promise<AuthMember | null> {
  const session = await readSessionMember(request, env);
  if (session) return session;
  if (!env.DEV_MEMBER_ID || !/^\d+$/.test(env.DEV_MEMBER_ID)) return null;
  return env.DB.prepare(`SELECT id, household_id, display_name FROM member WHERE id = ?`).bind(Number(env.DEV_MEMBER_ID)).first<AuthMember>();
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const editPage = request.method === "GET" ? url.pathname.match(/^\/recipes\/(\d+)\/edit$/) : null;
    const updateApi = request.method === "PUT" ? url.pathname.match(/^\/api\/recipes\/(\d+)$/) : null;
    const deleteApi = request.method === "DELETE" ? url.pathname.match(/^\/api\/recipes\/(\d+)$/) : null;
    if (editPage || updateApi || deleteApi) {
      const member = await memberFor(request, env);
      if (!member) return Response.json({ error: "Kirjautuminen vaaditaan." }, { status: 401 });
      const id = Number((editPage ?? updateApi ?? deleteApi)![1]);
      if (editPage) return recipeEditorPage(env.DB, member.household_id, id);
      if (updateApi) {
        try {
          const payload = validateRecipeEdit(await request.json());
          const updated = await updateRecipeFromDraft(env.DB, member.household_id, member.id, id, payload);
          return updated ? Response.json({ id }) : Response.json({ error: "Reseptiä ei löytynyt." }, { status: 404 });
        } catch (error) {
          return Response.json({ error: error instanceof Error ? error.message : "Tallennus epäonnistui." }, { status: 400 });
        }
      }
      const result = await deleteRecipe(env.DB, member.household_id, id);
      if (result === "deleted") return Response.json({ deleted: true });
      if (result === "in_use") return Response.json({ error: "Resepti on käytössä ruokalistalla eikä sitä voi poistaa." }, { status: 409 });
      return Response.json({ error: "Reseptiä ei löytynyt." }, { status: 404 });
    }
    return app.fetch(request, env);
  }
} satisfies ExportedHandler<Env>;
