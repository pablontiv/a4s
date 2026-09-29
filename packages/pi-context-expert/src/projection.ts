/**
 * Applies an optional request-time context projection without ever turning its
 * failure into an omission. The exact input object is returned on every error.
 */
export async function applyContextProjection<T>(
  context: T,
  project: () => Promise<T>,
): Promise<T> {
  try {
    return await project();
  } catch {
    return context;
  }
}
