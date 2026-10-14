/**
 * How the add screen's one box is read (#350): a name, a link, or a recipe.
 *
 * The box takes all three, and links may sit anywhere in a longer text. The
 * browser uses this to word its button and the server uses it to decide what to
 * fetch, so they are the same function — a box the screen called "a link" must
 * not be something the import treats as plain text.
 *
 * It is bundled into the ES5 intake client, so it uses nothing newer than ES5:
 * no `startsWith`, no `includes`, and not even `const` — esbuild will not
 * lower it for an ES5 target.
 */

/** At most this many links in one box are read; the rest stay as words. */
export var MAX_LINKS = 3;

/** A name longer than this is not a name somebody remembered. */
export var MAX_NAME_LENGTH = 80;

export type BoxKind = "empty" | "name" | "link" | "text";

// Punctuation a link is commonly written next to in a sentence.
var TRAILING = ".,;:!?)]}>\"'";
var LEADING = "([{<\"'";

/** The token with any sentence punctuation around it taken off. */
function bare(token: string): string {
  var start = 0;
  var end = token.length;
  while (start < end && LEADING.indexOf(token.charAt(start)) >= 0) start++;
  while (end > start && TRAILING.indexOf(token.charAt(end - 1)) >= 0) end--;
  return token.slice(start, end);
}

/**
 * Whether one whitespace-free token is written as a web address.
 *
 * A scheme or a leading `www.` is enough. Otherwise it needs a host with a dot
 * and a letters-only ending *and* a path, so `kotikokki.net/resepti` is a link
 * while `n.2` or `esim.` in a recipe is not. A bare `kotikokki.net` with no
 * path counts only when it is the whole box, which `linksIn` decides.
 */
function looksLikeLink(token: string, alone: boolean): boolean {
  var lower = token.toLowerCase();
  if (lower.indexOf("http://") === 0 || lower.indexOf("https://") === 0) {
    return lower.length > 8;
  }
  if (lower.indexOf("www.") === 0) return lower.length > 4;
  var slash = lower.indexOf("/");
  if (slash < 0 && !alone) return false;
  var host = slash < 0 ? lower : lower.slice(0, slash);
  var dot = host.lastIndexOf(".");
  if (dot <= 0) return false;
  var ending = host.slice(dot + 1);
  if (ending.length < 2) return false;
  for (var i = 0; i < ending.length; i++) {
    var c = ending.charAt(i);
    if (c < "a" || c > "z") return false;
  }
  return true;
}

function tokens(text: string): string[] {
  var out: string[] = [];
  var current = "";
  for (var i = 0; i < text.length; i++) {
    var c = text.charAt(i);
    if (c === " " || c === "\n" || c === "\t" || c === "\r") {
      if (current !== "") out.push(current);
      current = "";
    } else current += c;
  }
  if (current !== "") out.push(current);
  return out;
}

/** Every link written in the text, in order, each once. Not capped. */
export function linksIn(text: string): string[] {
  var words = tokens(text);
  var alone = words.length === 1;
  var found: string[] = [];
  for (var i = 0; i < words.length; i++) {
    var token = bare(words[i]!);
    if (token !== "" && looksLikeLink(token, alone) && found.indexOf(token) < 0) {
      found.push(token);
    }
  }
  return found;
}

/**
 * The text with its links taken out, trimmed — what the member wrote.
 *
 * `taken` says which written links were really used as links. The server
 * passes it, so a link it would not read (a fourth one, or one that is no
 * public address) stays in the text as words rather than vanishing from both
 * the pages and the text. Without it every link is taken out, which is all
 * the screen needs for its wording.
 */
export function withoutLinks(
  text: string,
  taken?: (written: string) => boolean,
): string {
  var found = linksIn(text);
  var links: string[] = [];
  for (var k = 0; k < found.length; k++) {
    if (!taken || taken(found[k]!)) links.push(found[k]!);
  }
  var lines = text.split("\n");
  var kept: string[] = [];
  for (var i = 0; i < lines.length; i++) {
    var words = tokens(lines[i]!);
    var left: string[] = [];
    for (var j = 0; j < words.length; j++) {
      if (links.indexOf(bare(words[j]!)) < 0) left.push(words[j]!);
    }
    kept.push(left.join(" "));
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * What the box holds. A link anywhere makes it a link; a single short line
 * with no link is a name; anything else is a recipe's text.
 */
export function boxKind(text: string): BoxKind {
  var trimmed = text.trim();
  if (trimmed === "") return "empty";
  if (linksIn(trimmed).length > 0) return "link";
  if (trimmed.indexOf("\n") < 0 && trimmed.length <= MAX_NAME_LENGTH) return "name";
  return "text";
}
