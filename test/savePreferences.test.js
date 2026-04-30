const test = require('node:test');
const assert = require('node:assert/strict');

const controllerPath = require.resolve('../controllers/userController');
const databasePath = require.resolve('../config/database');

const loadControllerWithMockPool = (userRow) => {
  delete require.cache[controllerPath];

  const calls = [];
  const connection = {
    beginTransaction: async () => {
      calls.push({ type: 'beginTransaction' });
    },
    execute: async (sql, params) => {
      calls.push({ sql, params });

      if (sql.startsWith('SELECT onboarding_completed')) {
        return [[userRow]];
      }

      if (sql.startsWith('UPDATE users SET')) {
        return [{ affectedRows: 1 }];
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
    commit: async () => {
      calls.push({ type: 'commit' });
    },
    rollback: async () => {
      calls.push({ type: 'rollback' });
    },
    release: () => {
      calls.push({ type: 'release' });
    },
  };

  const originalDatabaseModule = require.cache[databasePath];
  require.cache[databasePath] = {
    id: databasePath,
    filename: databasePath,
    loaded: true,
    exports: {
      pool: {
        getConnection: async () => connection,
      },
    },
  };

  const controller = require(controllerPath);

  return {
    controller,
    calls,
    restore: () => {
      delete require.cache[controllerPath];
      if (originalDatabaseModule) {
        require.cache[databasePath] = originalDatabaseModule;
      } else {
        delete require.cache[databasePath];
      }
    },
  };
};

const createResponseMock = () => {
  const response = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };

  return response;
};

test('savePreferences grants 2 days of premium when onboarding is completed for the first time', async () => {
  const { controller, calls, restore } = loadControllerWithMockPool({
    onboarding_completed: 0,
    premium_endtime: null,
  });

  try {
    const req = {
      user: { id: 42 },
      body: {
        preferred_language: 'tr',
        full_name: 'Ada Lovelace',
        age: 28,
        gender: 'female',
      },
    };
    const res = createResponseMock();

    await controller.savePreferences(req, res, (error) => {
      throw error;
    });

    const updateCall = calls.find((entry) => entry.sql && entry.sql.startsWith('UPDATE users SET'));
    assert.ok(updateCall, 'expected an update query');
    assert.match(updateCall.sql, /is_premium = 1/);
    assert.match(updateCall.sql, /premium_endtime = \?/);

    const premiumEndTime = updateCall.params[updateCall.params.length - 2];
    assert.ok(premiumEndTime instanceof Date, 'premium end time should be a Date');

    const expectedEndTime = Date.now() + 2 * 24 * 60 * 60 * 1000;
    assert.ok(
      Math.abs(premiumEndTime.getTime() - expectedEndTime) < 5000,
      'premium end time should be approximately 2 days from now',
    );

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.premiumGranted, true);
    assert.equal(res.body.data.onboardingCompleted, true);
  } finally {
    restore();
  }
});

test('savePreferences does not grant premium again after onboarding was already completed', async () => {
  const existingPremiumEndTime = new Date('2026-05-05T00:00:00.000Z');
  const { controller, calls, restore } = loadControllerWithMockPool({
    onboarding_completed: 1,
    premium_endtime: existingPremiumEndTime,
  });

  try {
    const req = {
      user: { id: 42 },
      body: {
        preferred_language: 'tr',
      },
    };
    const res = createResponseMock();

    await controller.savePreferences(req, res, (error) => {
      throw error;
    });

    const updateCall = calls.find((entry) => entry.sql && entry.sql.startsWith('UPDATE users SET'));
    assert.ok(updateCall, 'expected an update query');
    assert.doesNotMatch(updateCall.sql, /is_premium = 1/);
    assert.doesNotMatch(updateCall.sql, /premium_endtime = \?/);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.premiumGranted, false);
    assert.equal(res.body.data.premiumEndTime, null);
  } finally {
    restore();
  }
});