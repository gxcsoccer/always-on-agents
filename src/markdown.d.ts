/** A Markdown file shipped with the Worker is its text. */
declare module "*.md" {
  const text: string;
  export default text;
}
