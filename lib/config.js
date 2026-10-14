// Honduras instruments. Override only when intentionally changing instruments.
export const observationSurveyId = () => process.env.QUALTRICS_SURVEY_ID || 'SV_9LXy32LyJuSlvgi';
export const courierSurveyId = () => process.env.QUALTRICS_COURIER_SURVEY_ID || 'SV_8e48NZfmjF2fFrM';

// Match these to the Honduras survey definition if its question IDs differ.
export const operationQuestionId = () => process.env.QUALTRICS_OPERATION_QUESTION_ID || 'QID27';
export const vehicleQuestionId = () => process.env.QUALTRICS_VEHICLE_QUESTION_ID || 'QID8';
export const photoQuestionId = () => process.env.QUALTRICS_PHOTO_QUESTION_ID || 'QID17';

export function photoValue(row, field) {
  const qid = photoQuestionId();
  const number = qid.replace(/^QID/i, '');
  const suffixes = field === 'id'
    ? [`${qid}_FILE_ID`, `Q${number}_Id`, `Q${number}_ID`]
    : [`${qid}_FILE_NAME`, `Q${number}_Name`, `Q${number}_NAME`];
  return suffixes.map(key => row[key]).find(value => value != null && String(value).trim() !== '') ?? null;
}
