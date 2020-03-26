import * as Smooch from 'smooch-core';
import { debugRequest, debugResponse, debugSmooch } from '../debuggers';
import { Integrations } from '../models';
import { getSmoochConfig, saveConversation, saveCustomer, saveMessage, getTelegramFile } from './api';
import { SMOOCH_MODELS } from './store';
import { IAttachment, ISmoochCustomerInput } from './types';

export interface ISmoochProps {
  kind: string;
  erxesApiId: string;
  telegramBotToken?: string;
  viberBotToken?: string;
  smoochDisplayName?: string;
  lineChannelId?: string;
  lineChannelSecret?: string;
  twilioSid?: string;
  twilioAuthToken?: string;
  twilioPhoneSid?: string;
}

interface IMessage {
  text: string;
  role: string;
  type: string;
  mediaUrl?: string;
}

let smooch: Smooch;
let appId = '';

const init = async app => {
  app.post('/smooch/webhook', async (req, res) => {
    debugSmooch('Received new message in smooch...');

    const { trigger } = req.body;

    if (trigger === 'message:appUser') {
      const { appUser, messages, conversation, client } = req.body;

      const smoochIntegrationId = client.integrationId;

      const customer: ISmoochCustomerInput = {
        smoochIntegrationId,
        surname: appUser.surname,
        givenName: appUser.givenName,
        smoochUserId: appUser._id,
      };

      if (client.platform === 'twilio') {
        customer.phone = client.displayName;
      } else if (client.platform === 'telegram' && client.raw.profile_photos.total_count !== 0) {
        const { file_id } = client.raw.profile_photos.photos[0][0];

        const { telegramBotToken } = await Integrations.findOne({ smoochIntegrationId });

        customer.avatarUrl = await getTelegramFile(telegramBotToken, file_id);
      } else if (client.platform === 'line' && client.raw.pictureUrl) {
        customer.avatarUrl = client.raw.pictureUrl;
      } else if (client.platform === 'viber' && client.raw.avatar) {
        customer.avatarUrl = client.raw.avatar;
      }

      for (const message of messages) {
        const content = message.text;
        const received = message.received;

        const customerId = await saveCustomer(customer);

        const conversationIds = await saveConversation(
          smoochIntegrationId,
          conversation._id,
          customerId,
          content,
          received,
        );

        if (message.type !== 'text') {
          const attachment: IAttachment = { type: message.mediaType, url: message.mediaUrl };
          await saveMessage(smoochIntegrationId, customerId, conversationIds, content, message._id, attachment);
        } else {
          await saveMessage(smoochIntegrationId, customerId, conversationIds, content, message._id);
        }
      }
    }

    return res.status(200).send('success');
  });

  app.post('/smooch/create-integration', async (req, res, next) => {
    debugRequest(debugSmooch, req);
    let { kind } = req.body;

    if (kind.includes('smooch')) {
      kind = kind.split('-')[1];
    }

    const { data, integrationId } = req.body;
    const props = JSON.parse(data);
    props.type = kind;

    const smoochProps = <ISmoochProps>{
      kind,
      erxesApiId: integrationId,
    };

    if (kind === 'telegram') {
      smoochProps.telegramBotToken = props.token;
    } else if (kind === 'viber') {
      smoochProps.viberBotToken = props.token;
    } else if (kind === 'line') {
      smoochProps.lineChannelId = props.channelId;
      smoochProps.lineChannelSecret = props.channelSecret;
    } else if (kind === 'twilio') {
      smoochProps.twilioSid = props.accountSid;
      smoochProps.twilioAuthToken = props.authToken;
      smoochProps.twilioPhoneSid = props.phoneNumberSid;
    }

    smoochProps.smoochDisplayName = props.displayName;

    const integration = await Integrations.create(smoochProps);

    try {
      const result = await smooch.integrations.create({ appId, props });

      await Integrations.updateOne({ _id: integration.id }, { $set: { smoochIntegrationId: result.integration._id } });
    } catch (e) {
      debugSmooch(`Failed to create smooch integration: ${e.message}`);
      next(new Error(e.message));
      await Integrations.deleteOne({ _id: integration.id });
    }

    return res.json({ status: 'ok' });
  });

  app.post('/smooch/reply', async (req, res, next) => {
    const { attachments, conversationId, content, integrationId } = req.body;
    if (attachments.length > 1) {
      throw new Error('You can only attach one file');
    }

    const integration = await Integrations.findOne({ erxesApiId: integrationId });

    const conversationModel = SMOOCH_MODELS[integration.kind].conversations;

    const customerModel = SMOOCH_MODELS[integration.kind].customers;

    const conversation = await conversationModel.findOne({ erxesApiId: conversationId });

    const customerId = conversation.customerId;

    const user = await customerModel.findOne({ erxesApiId: customerId });

    try {
      const messageInput: IMessage = { text: content, role: 'appMaker', type: 'text' };

      if (attachments.length !== 0) {
        messageInput.type = 'file';
        messageInput.mediaUrl = attachments[0].url;
      }

      const { message } = await smooch.appUsers.sendMessage({
        appId,
        userId: user.smoochUserId,
        message: messageInput,
      });

      const messageModel = SMOOCH_MODELS[integration.kind].conversationMessages;

      await messageModel.create({
        conversationId: conversation.id,
        messageId: message._id,
        content,
      });
    } catch (e) {
      debugSmooch(`Failed to send smooch message: ${e.message}`);
      next(new Error(e.message));
    }

    debugResponse(debugSmooch, req);

    res.sendStatus(200);
  });
};

export const setupSmooch = async () => {
  const { SMOOCH_APP_KEY_ID, SMOOCH_SMOOCH_APP_KEY_SECRET, SMOOCH_APP_ID } = await getSmoochConfig();

  appId = SMOOCH_APP_ID;

  if (!SMOOCH_APP_KEY_ID || !SMOOCH_SMOOCH_APP_KEY_SECRET) {
    debugSmooch(`
      Missing following config
      SMOOCH_APP_KEY_ID: ${SMOOCH_APP_KEY_ID}
      SMOOCH_SMOOCH_APP_KEY_SECRET: ${SMOOCH_SMOOCH_APP_KEY_SECRET}
    `);
    return;
  }

  smooch = new Smooch({
    keyId: SMOOCH_APP_KEY_ID,
    secret: SMOOCH_SMOOCH_APP_KEY_SECRET,
    scope: 'app',
  });
};

export default init;