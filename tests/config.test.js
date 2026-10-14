import assert from 'node:assert/strict';
import { test } from 'node:test';
import { observationSurveyId, courierSurveyId, operationQuestionId, vehicleQuestionId, photoQuestionId, photoValue } from '../lib/config.js';
import { isFinished, normalizeResponse } from '../lib/qualtrics.js';

test('Honduras defaults and question ID overrides are independent', () => {
  const names = ['QUALTRICS_SURVEY_ID','QUALTRICS_COURIER_SURVEY_ID','QUALTRICS_OPERATION_QUESTION_ID','QUALTRICS_VEHICLE_QUESTION_ID','QUALTRICS_PHOTO_QUESTION_ID'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    names.forEach(name => delete process.env[name]);
    assert.equal(observationSurveyId(), 'SV_9LXy32LyJuSlvgi');
    assert.equal(courierSurveyId(), 'SV_8e48NZfmjF2fFrM');
    assert.equal(operationQuestionId(), 'QID27');
    assert.equal(vehicleQuestionId(), 'QID8');
    assert.equal(photoQuestionId(), 'QID17');
    process.env.QUALTRICS_PHOTO_QUESTION_ID = 'QID42';
    assert.equal(photoValue({QID42_FILE_ID:'file-42',QID17_FILE_ID:'old-file'}, 'id'), 'file-42');
    assert.equal(photoValue({Q42_Name:'vehicle.png'}, 'name'), 'vehicle.png');
    assert.equal(photoValue({QID17_FILE_ID:'old-file'}, 'id'), null);
    assert.equal(observationSurveyId(), 'SV_9LXy32LyJuSlvgi');
  } finally {
    names.forEach(name => saved[name] === undefined ? delete process.env[name] : process.env[name] = saved[name]);
  }
});

test('only explicitly finished exported responses are counted as completed', () => {
  assert.equal(isFinished(normalizeResponse({responseId:'test',values:{finished:1}})), true);
  for (const Finished of [0,false,'false','',undefined]) assert.equal(isFinished({Finished}), false);
});
