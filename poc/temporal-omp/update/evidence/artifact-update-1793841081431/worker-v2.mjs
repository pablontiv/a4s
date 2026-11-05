export function createActivities() {
  return { async execute(binding, values) {
    return { binding, implementation: 'v2-sum-of-squares', value: values.reduce((sum, value) => sum + value * value, 0) };
  } };
}
