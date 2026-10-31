/** The text of a thrown value: an Error's message, otherwise its string form. */
export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
