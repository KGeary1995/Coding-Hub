/** Focus and mouse reports a terminal sends on its own; they are not the person answering a prompt. */
export function isPersonInput(data: string) {
  return data.replace(/\x1b\[[IO]|\x1b\[<\d+;\d+;\d+[mM]|\x1b\[M[\s\S]{3}/g, '').length > 0;
}
