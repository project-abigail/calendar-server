const chakram = require('chakram');
const expect = chakram.expect;
const sinon = require('sinon');
const mq = require('zmq').socket('pull');

const serverManager = require('./server_manager');
const api = require('./api_tooling');
const config = require('./config.js');
const database = require('../dao/database');

const { waitUntilReminderHasStatus } = require('./lib/wait');

function waitForMqMessage() {
  return new Promise(resolve => {
    mq.once('message', (message) => {
      message = JSON.parse(message.toString());
      // Undeterministic timestamp. Asserting against it doesn't
      // provide any value to the test
      delete message.reminder.created;
      resolve(message);
    });
  });
}

describe('notifications', function() {
  const users = [
    {
      username: 'john@helloworld.com',
      password: 'Hello World',
      forename: 'John',
    },
    {
      username: 'Julien@julien.com',
      password: 'Hello World',
      forename: 'Julien',
    },
    {
      username: 'johan@johan.com',
      password: 'Hello France',
      forename: 'Johan',
    }
  ];

  let subscriptions;
  let expectedSubscriptions;
  let inputs;
  let outputs;

  function setupExpectations() {
    subscriptions = [];
    expectedSubscriptions = [];

    users.forEach((user, i) => {
      const id = i + 1;
      const userId = user.id;
      const subscription = {
        title: `subscription_user_${id}`,
        subscription: {
          endpoint: `https://endpoint/user/${id}`,
          keys: {
            p256dh: 'some_base_64',
            auth: 'some_base_64'
          }
        }
      };

      subscriptions.push(subscription);

      expectedSubscriptions.push({
        id,
        userId,
        title: subscription.title,
        subscription: {
          endpoint: subscription.subscription.endpoint,
          keys: {
            p256dh: subscription.subscription.keys.p256dh,
            auth: subscription.subscription.keys.auth
          },
        },
      });
    });

    inputs = [{
      recipients: [{ id: users[0].id }],
      action: 'Pick up kids at school',
      due: Date.now(),
    }, {
      recipients: [{ id: users[1].id }],
      action: 'Buy milk',
      due: Date.now(),
    }, {
      recipients: [{ id: users[2].id }],
      action: 'Go to school',
      due: Date.now(),
    }];

    outputs = inputs.map((input, i) => {
      const reminder = {
        id: i + 1,
        action: input.action,
        due: input.due,
        // FIXME: The status value shouldn't be sent to the message queue, as it
        // gives an outdated information
        status: 'waiting'
      };

      return {
        reminder,
        notifications: [{
          subscription: expectedSubscriptions[i]
        }]
      };
    });

  }

  const mqSocket = `tcp://127.0.0.1:${config.mqPort}`;

  let groupId;

  beforeEach(function*() {
    yield serverManager.start();
    yield api.loginAsMaster();
    for (const user of users) {
      user.id = yield api.createUser(user);
    }

    setupExpectations();

    yield api.login(users[0].username, users[0].password);
    groupId = yield api.createGroup({ name: 'CD_Staff' });
    yield api.addUserToGroup(users[1].id, groupId);
    yield api.addUserToGroup(users[2].id, groupId);
  });

  afterEach(function* () {
    yield serverManager.stop();
  });

  describe('no subscription registered', function() {
    beforeEach(function() {
      return database.init(config.profilePath);
    });

    afterEach(function() {
      return database.close();
    });

    it('marks reminder as errored', function*() {
      const mqMessageSpy = sinon.spy();
      waitForMqMessage().then(mqMessageSpy);

      const reminderId = yield api.createReminder(inputs[0]);
      yield waitUntilReminderHasStatus(
        reminderId, 'error-no-subscription'
      );
      sinon.assert.notCalled(mqMessageSpy);
    });
  });

  describe('once subscriptions are registered', function() {
    beforeEach(function*() {
      mq.connect(mqSocket);
      for (let i = 0; i < users.length; i++) {
        yield api.login(users[i].username, users[i].password);
        yield api.createSubscription(subscriptions[i]);
      }
    });

    afterEach(function() {
      mq.disconnect(mqSocket);
    });

    it('sends reminders to the right person and ' +
       'does not send a reminder twice to the message queue', function*() {
      // We try to determine if the first reminder has been sent only once.
      // In order to do so, we verify that this reminder is not sent a second
      // time in the second setInterval. As our SQL queries are not ordered, it
      // might occur that the first reminder pops up after the second one (in
      // the second interval). Hence, the 3rd reminder is a sentinel to make
      // sure we entered a new interval.
      for (let i = 0; i < inputs.length; i++) {
        yield api.createReminder(inputs[i]);

        const message = yield waitForMqMessage();
        expect(message).deep.equal(outputs[i]);
      }
    });
  });

  describe('sms notifications', function() {
    beforeEach(function() {
      mq.connect(mqSocket);
    });

    afterEach(function() {
      mq.disconnect(mqSocket);
    });

    it('Properly sends SMS notifications', function*() {
      const user = {
        username: '2123456789',
        password: 'Hello World',
        forename: 'Preeti',
        phoneNumber: '2123456789',
      };

      yield api.loginAsMaster();
      user.id = yield api.createUser(user);
      yield api.login(users[0].username, users[0].password);

      yield api.addUserToGroup(user.id, groupId);

      const reminder = {
        recipients: [{ id: user.id }],
        action: 'Shopping',
        due: Date.UTC(2016, 9, 19, 16) // 5pm UTC
      };

      reminder.id = yield api.createReminder(reminder);
      reminder.status = 'waiting';
      delete reminder.recipients;

      const message = yield waitForMqMessage();
      expect(message).deep.equal({
        reminder,
        notifications: [{
          sms: {
            // time is in PDT (summer time, UTC-7)
            body: `Reminder from Abigail:\n${reminder.action} at 9:00 AM`,
            target: user.phoneNumber
          }
        }]
      });
    });
  });
});
