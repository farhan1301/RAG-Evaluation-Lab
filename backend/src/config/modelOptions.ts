// The transitional chat transport supports only the provider default temperature on these models.
export function supportsTemperature(model: string) {
  const normalized = model.toLowerCase();
  return !(
    normalized.startsWith('gpt-5') &&
    (normalized.includes('mini') || normalized.includes('nano'))
  );
}
