{{- define "loopscene.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "loopscene.labels" -}}
app.kubernetes.io/name: {{ include "loopscene.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/*
Image references are digest-pinned. A mutable tag would make "roll back to the
previous release" ambiguous, so the chart fails rather than deploying one.
*/}}
{{- define "loopscene.apiImage" -}}
{{- if not .Values.image.registry -}}
{{- fail "image.registry is required (the ECR registry host from terraform output)" -}}
{{- end -}}
{{- if not .Values.image.api.repository -}}
{{- fail "image.api.repository is required, e.g. loopscene-staging-api" -}}
{{- end -}}
{{- if not .Values.image.api.digest -}}
{{- fail "image.api.digest is required: images must be pinned by digest, not tag" -}}
{{- end -}}
{{ .Values.image.registry }}/{{ .Values.image.api.repository }}@{{ .Values.image.api.digest }}
{{- end -}}

{{- define "loopscene.workerImage" -}}
{{- if not .Values.image.registry -}}
{{- fail "image.registry is required (the ECR registry host from terraform output)" -}}
{{- end -}}
{{- if not .Values.image.worker.repository -}}
{{- fail "image.worker.repository is required, e.g. loopscene-staging-worker" -}}
{{- end -}}
{{- if not .Values.image.worker.digest -}}
{{- fail "image.worker.digest is required: images must be pinned by digest, not tag" -}}
{{- end -}}
{{ .Values.image.registry }}/{{ .Values.image.worker.repository }}@{{ .Values.image.worker.digest }}
{{- end -}}

{{/*
Shared environment, split into the two keys a container spec expects.
Secrets come exclusively from `envFromSecret`; nothing sensitive is rendered
into the ConfigMap or into Helm release history (SEC-06).
*/}}
{{/*
`runMode` becomes RUN_MODE, which the API parses as an enum of exactly
demo | integration | production. `deploy/envs/staging.yaml` said "staging" —
not a member — so every pod in that environment would have exited at boot.
Caught here so it fails in CI at `helm template` rather than as a CrashLoopBackOff.

This is the ONLY value the chart re-validates. The API already refuses to start
and names every missing or contradictory setting (empty buckets, a live Stripe
key in integration mode, the demo music adapter in production). Re-implementing
that list in Go templates would create a second source of truth that drifts from
the first, which is the failure this repository keeps finding in its own docs.
*/}}
{{- define "loopscene.envVars" -}}
{{- if not (has .Values.runMode (list "demo" "integration" "production")) -}}
{{- fail (printf "runMode %q is not one of demo|integration|production" .Values.runMode) -}}
{{- end -}}
- name: RUN_MODE
  value: {{ .Values.runMode | quote }}
- name: NODE_ENV
  value: "production"
{{- end -}}

{{- define "loopscene.envFrom" -}}
- configMapRef:
    name: {{ include "loopscene.name" . }}-config
- secretRef:
    name: {{ .Values.envFromSecret }}
{{- end -}}
