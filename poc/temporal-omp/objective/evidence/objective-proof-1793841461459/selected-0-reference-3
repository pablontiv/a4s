'use strict';
const { proxyActivities } = require('@temporalio/workflow');
const { recordCompletion } = proxyActivities({ startToCloseTimeout: '10 seconds' });
exports.sqlitePersistenceProof = async function sqlitePersistenceProof(binding) {
  return await recordCompletion(binding);
};
