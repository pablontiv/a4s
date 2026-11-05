export function createActivities({ started, released }) {
  return { async execute(binding, values) {
    started();
    await released;
    return { binding, implementation: 'v1-sum', value: values.reduce((sum, value) => sum + value, 0) };
  } };
}
