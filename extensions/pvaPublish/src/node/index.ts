import { getStatus, history, publish } from './publish';

function initialize(registration) {
  const plugin = {
    customDescription: 'Publish bot to Power Virtual Agents (Preview)',
    hasView: true /** we have custom UI to host */,
    history,
    getStatus,
    publish,
  };
  registration.addPublishMethod(plugin);
}

module.exports = {
  initialize,
};
