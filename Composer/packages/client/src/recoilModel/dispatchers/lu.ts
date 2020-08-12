// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
/* eslint-disable react-hooks/rules-of-hooks */
import { LuFile, LuIntentSection } from '@bfc/shared';
import { useRecoilCallback, CallbackInterface } from 'recoil';
import differenceBy from 'lodash/differenceBy';
import formatMessage from 'format-message';

import luWorker from '../parsers/luWorker';
import { getBaseName, getExtension } from '../../utils/fileUtil';
import * as luUtil from '../../utils/luUtil';
import luFileStatusStorage from '../../utils/luFileStatusStorage';
import {
  luFilesState,
  botLoadErrorState,
  botStatusState,
  dialogsState,
  localeState,
  settingsState,
} from '../atoms/botState';

import httpClient from './../../utils/httpUtil';
import { Text, BotStatus } from './../../constants';

const intentIsNotEmpty = ({ Name, Body }) => {
  return !!Name && !!Body;
};
// fill other locale luFile new added intent with '- '
const initialBody = '- ';

export const updateLuFileState = (luFiles: LuFile[], updatedLuFile: LuFile, projectId: string) => {
  const { id } = updatedLuFile;
  const dialogId = getBaseName(id);
  const locale = getExtension(id);
  const originLuFile = luFiles.find((file) => id === file.id);
  const sameIdOtherLocaleFiles = luFiles.filter((file) => {
    const fileDialogId = getBaseName(file.id);
    const fileLocale = getExtension(file.id);
    return fileDialogId === dialogId && locale !== fileLocale;
  });

  if (!originLuFile) {
    throw new Error(formatMessage('origin lu file not found in store'));
  }

  const changes: LuFile[] = [updatedLuFile];

  const addedIntents = differenceBy(updatedLuFile.intents, originLuFile.intents, 'Name')
    .filter(intentIsNotEmpty)
    .map((t) => {
      return {
        ...t,
        Body: initialBody,
      };
    });
  const deletedIntents = differenceBy(originLuFile.intents, updatedLuFile.intents, 'Name').filter(intentIsNotEmpty);
  const onlyAdds = addedIntents.length && !deletedIntents.length;
  const onlyDeletes = !addedIntents.length && deletedIntents.length;
  // sync add/remove intents
  if (onlyAdds || onlyDeletes) {
    for (const item of sameIdOtherLocaleFiles) {
      let newLuFile = luUtil.addIntents(item, addedIntents);
      newLuFile = luUtil.removeIntents(
        newLuFile,
        deletedIntents.map(({ Name }) => Name)
      );
      changes.push(newLuFile);
    }
  }

  changes.forEach(({ id }) => {
    luFileStatusStorage.updateFileStatus(projectId, id);
  });

  return luFiles.map((file) => {
    const changedFile = changes.find(({ id }) => id === file.id);
    return changedFile ? changedFile : file;
  });
};

export const createLuFileState = async (
  callbackHelpers: CallbackInterface,
  { id, content, projectId }: { id: string; content: string; projectId: string }
) => {
  const { set, snapshot } = callbackHelpers;
  const luFiles = await snapshot.getPromise(luFilesState(projectId));
  const locale = await snapshot.getPromise(localeState(projectId));
  const { languages } = await snapshot.getPromise(settingsState(projectId));
  const createdLuId = `${id}.${locale}`;
  const createdLuFile = (await luUtil.parse(id, content)) as LuFile;
  if (luFiles.find((lg) => lg.id === createdLuId)) {
    throw new Error('lu file already exist');
  }
  const changes: LuFile[] = [];

  // copy to other locales
  languages.forEach((lang) => {
    const fileId = `${id}.${lang}`;
    luFileStatusStorage.updateFileStatus(projectId, fileId);
    changes.push({
      ...createdLuFile,
      id: fileId,
    });
  });

  set(luFilesState(projectId), [...luFiles, ...changes]);
};

export const removeLuFileState = async (
  callbackHelpers: CallbackInterface,
  { id, projectId }: { id: string; projectId: string }
) => {
  const { set, snapshot } = callbackHelpers;
  let luFiles = await snapshot.getPromise(luFilesState(projectId));

  luFiles.forEach((file) => {
    if (getBaseName(file.id) === getBaseName(id)) {
      luFileStatusStorage.removeFileStatus(projectId, id);
    }
  });

  luFiles = luFiles.filter((file) => getBaseName(file.id) !== id);
  set(luFilesState(projectId), luFiles);
};

export const luDispatcher = () => {
  const updateLuFile = useRecoilCallback(
    ({ set }: CallbackInterface) => async ({
      id,
      content,
      projectId,
    }: {
      id: string;
      content: string;
      projectId: string;
    }) => {
      const updatedFile = (await luWorker.parse(id, content)) as LuFile;
      set(luFilesState(projectId), (luFiles) => {
        return updateLuFileState(luFiles, updatedFile, projectId);
      });
    }
  );

  const updateLuIntent = useRecoilCallback(
    ({ set }: CallbackInterface) => ({
      id,
      intentName,
      intent,
      projectId,
    }: {
      id: string;
      intentName: string;
      intent: LuIntentSection;
      projectId: string;
    }) => {
      set(luFilesState(projectId), (luFiles) => {
        const file = luFiles.find((temp) => temp.id === id);
        if (!file) return luFiles;
        const updatedFile = luUtil.updateIntent(file, intentName, intent);
        return updateLuFileState(luFiles, updatedFile, projectId);
      });
    }
  );

  const createLuIntent = useRecoilCallback(
    ({ set }: CallbackInterface) => ({
      id,
      intent,
      projectId,
    }: {
      id: string;
      intent: LuIntentSection;
      projectId: string;
    }) => {
      set(luFilesState(projectId), (luFiles) => {
        const file = luFiles.find((temp) => temp.id === id);
        if (!file) return luFiles;
        const updatedFile = luUtil.addIntent(file, intent);
        return updateLuFileState(luFiles, updatedFile, projectId);
      });
    }
  );

  const removeLuIntent = useRecoilCallback(
    ({ set }: CallbackInterface) => ({
      id,
      intentName,
      projectId,
    }: {
      id: string;
      intentName: string;
      projectId: string;
    }) => {
      set(luFilesState(projectId), (luFiles) => {
        const file = luFiles.find((temp) => temp.id === id);
        if (!file) return luFiles;
        const updatedFile = luUtil.removeIntent(file, intentName);
        return updateLuFileState(luFiles, updatedFile, projectId);
      });
    }
  );

  const publishLuis = useRecoilCallback(
    ({ set, snapshot }: CallbackInterface) => async (luisConfig, projectId: string) => {
      const dialogs = await snapshot.getPromise(dialogsState(projectId));
      try {
        const luFiles = await snapshot.getPromise(luFilesState(projectId));
        const referred = luUtil.checkLuisPublish(luFiles, dialogs);
        //TODO crosstrain should add locale
        const crossTrainConfig = luUtil.createCrossTrainConfig(dialogs, referred);
        await httpClient.post(`/projects/${projectId}/luFiles/publish`, {
          luisConfig,
          projectId,
          crossTrainConfig,
          luFiles: referred.map((file) => file.id),
        });
        luFileStatusStorage.publishAll(projectId);
        set(botStatusState(projectId), BotStatus.published);
      } catch (err) {
        set(botStatusState(projectId), BotStatus.failed);
        set(botLoadErrorState(projectId), {
          title: Text.LUISDEPLOYFAILURE,
          message: err.response?.data?.message || err.message,
        });
      }
    }
  );

  return {
    updateLuFile,
    updateLuIntent,
    createLuIntent,
    removeLuIntent,
    publishLuis,
  };
};