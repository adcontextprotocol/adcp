(function initSlackCta(global) {
  'use strict';

  global.resolveSlackCta = function resolveSlackCta(options) {
    const inviteUrl = global.safeExternalHttpUrl(options?.inviteUrl);
    const channelUrl = global.safeExternalHttpUrl(options?.channelUrl);
    const opensChannel = options?.isLinkedToSlack === true && Boolean(channelUrl);

    return {
      url: opensChannel ? channelUrl : (inviteUrl || channelUrl),
      label: opensChannel ? 'Open Slack Channel' : 'Join Slack Workspace',
    };
  };
})(window);
