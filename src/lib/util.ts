/** True when a Management API call failed because the thing does not exist. */
export const isNotFound = (error: unknown): boolean => {
  const status = (error as { originalError?: { response?: { status?: number } } } | undefined)?.originalError?.response
    ?.status;
  return status === 404;
};

export const errorMessage = (error: unknown): string => {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return String(error);
};

/** Runs `fn` over `inputs` with at most `limit` calls in flight, keeping the input order. */
export const mapWithLimit = async <TIn, TOut>(
  inputs: readonly TIn[],
  limit: number,
  fn: (input: TIn) => Promise<TOut>,
): Promise<TOut[]> => {
  const results: TOut[] = new Array<TOut>(inputs.length);
  let next = 0;

  const worker = async () => {
    while (next < inputs.length) {
      const index = next++;
      results[index] = await fn(inputs[index] as TIn);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, inputs.length) }, worker));
  return results;
};

export const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];

/** "1 item", "2 items": a count with the noun in the right form. */
export const plural = (count: number, singular: string, pluralForm = `${singular}s`): string =>
  `${count} ${count === 1 ? singular : pluralForm}`;
