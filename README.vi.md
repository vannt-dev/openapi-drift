# openapi-drift

[![npm](https://img.shields.io/npm/v/openapi-drift)](https://www.npmjs.com/package/openapi-drift)
[![CI](https://github.com/vannt-dev/openapi-drift/actions/workflows/ci.yml/badge.svg)](https://github.com/vannt-dev/openapi-drift/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

English: [README.md](README.md)

Giữ cho tài liệu OpenAPI không nói dối. `openapi-drift` đọc các route mà code **NestJS** hoặc **Express** của bạn thật sự khai báo, so với tài liệu, và báo độ lệch theo cả hai chiều:

- route code đang phục vụ mà tài liệu không mô tả,
- operation tài liệu mô tả mà không route nào phục vụ,
- và, ở mức ghi chú, tham số đường dẫn đặt tên khác nhau (`{id}` trong tài liệu, `:orderId` trong code).

Mọi thứ dựng trên tài liệu (test sinh tự động, SDK client, mock, người review) chỉ đúng khi tài liệu đúng. Chạy trong CI thì một pull request không thể đổi API mà không đổi tài liệu.

```
$ openapi-drift check --spec openapi.yaml --source src --prefix /api
openapi.yaml: 9 operations under /api
src: 12 routes under /api

In the code, not in the document (5):
  GET     /api/health (src/health.controller.ts:5)
  HEAD    /api/health (src/health.controller.ts:10)
  GET     /api/legacy/ping (src/health.controller.ts:18)
  DELETE  /api/users/{id} (src/users/users.controller.ts:27) — the path exists with GET, PATCH
  GET     /api/v0/ping (src/health.controller.ts:18)

In the document, not in the code (2):
  POST    /api/orders (createOrder) — the path exists with GET
  GET     /api/users/{id}/avatar (getAvatar)

Path parameters named differently (1, not a failure):
  GET     /api/orders/{id}/items: document {id}, code {orderId} (src/orders/orders.controller.ts:10)

7 drifts.
```

Không AI, không mạng, không cần build dự án của bạn: route được đọc từ văn bản nguồn, nên chạy trong một giây trên mọi runner CI.

## Cài đặt

```bash
npm install -g openapi-drift      # hoặc: npx openapi-drift check ...
```

Node.js 22.18 trở lên.

## Dùng

```bash
openapi-drift check --spec openapi.yaml --source src            # exit 1 khi có lệch
openapi-drift check --spec openapi.yaml --source src --prefix /api --fail-on spec --format markdown --output drift.md
openapi-drift routes --source src                                # chỉ liệt kê route code khai báo
openapi-drift lint --spec openapi.yaml                           # lỗi của chính tài liệu
```

| Tuỳ chọn | Ý nghĩa |
| --- | --- |
| `--spec <file>` | Tài liệu OpenAPI 3, YAML hoặc JSON. |
| `--source <dir>` | Thư mục nguồn backend (mặc định `.`). Bỏ qua `node_modules`, `dist`, `build`, file test và `.d.ts`. |
| `--framework` | `nestjs`, `express` hoặc `auto` (mặc định): NestJS khi có file `.ts` khai báo `@Controller`. |
| `--prefix <path>` | Tiền tố code thêm vào mọi route mà nguồn không hiện ra: NestJS `app.setGlobalPrefix('api')`, mount Express dựng động. Base path của tài liệu (`servers[0].url`) được tự đọc. |
| `--format` | `text` (mặc định), `markdown` hoặc `json`. |
| `--output <file>` | Ghi thêm báo cáo ra file. |
| `--fail-on` | `any` (mặc định): lệch chiều nào cũng fail; `spec`: chỉ route tài liệu thiếu; `code`: chỉ operation code thiếu; `none`: chỉ báo cáo. |

Mã thoát: `0` không lệch, `1` có lệch, `2` dùng sai hoặc tài liệu có lỗi (`lint` liệt kê trước).

### Đọc được gì

**NestJS**: `@Controller('users')`, `@Controller({ path: 'users' })`, `@Controller(['a', 'b'])`, cùng `@Get`, `@Post`, `@Put`, `@Patch`, `@Delete`, `@Head`, `@Options`, `@All` và tham số đường dẫn, trong file `.ts` và `.js`. `:id` thành `{id}`. Global prefix và URI versioning không đọc từ code: truyền `--prefix`.

**Express**: `app.get('/x', ...)` và các verb khác, `router.get(...)`, `app.route('/x').get(...).post(...)`, `app.all(...)`, với router mount bằng `app.use('/prefix', router)` trong cùng file hoặc import từ file khác (`import users from './users.js'`, `const users = require('./users')`). Route có đường dẫn không phải chuỗi literal thì bỏ qua; router không được mount giữ nguyên đường dẫn của nó. Bỏ qua comment.

Đường dẫn so sánh bỏ qua tên tham số và hoa thường, nên `/users/{id}` và `/Users/:userId` là một; tên khác nhau được báo ở mức ghi chú, không fail.

## GitHub Action

```yaml
# .github/workflows/openapi-drift.yml
name: OpenAPI drift
on: [pull_request]
jobs:
  drift:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: vannt-dev/openapi-drift@v0
        with:
          spec: openapi.yaml
          source: src
          prefix: /api # tuỳ chọn
          fail-on: any # hoặc spec, code, none
```

Báo cáo Markdown vào job summary và file `openapi-drift.md` (input `report`); output `drifts` mang số lệch, để bước sau đăng thành bình luận trên pull request.

## Dùng như thư viện

```ts
import { loadSpec, extractRoutes, compare, markdownReport } from 'openapi-drift';

const doc = loadSpec('openapi.yaml');
const { routes } = extractRoutes('src', { framework: 'auto', prefix: '/api' });
const result = compare(doc, routes, { prefix: '/api' });
console.log(markdownReport(result, { spec: 'openapi.yaml', source: 'src', root: process.cwd() }));
```

Có kèm khai báo kiểu.

## Liên quan

- [openapi-postman-test-generator](https://github.com/vannt-dev/openapi-postman-test-generator) sinh Postman collection và API test từ tài liệu mà `openapi-drift` giữ cho đúng.
- [AIWS](https://github.com/vannt-dev/aiws-factory) chạy phép so sánh này trong phase review của quy trình requirement.

## Lộ trình

Đọc route Spring (`@RequestMapping`) và Fastify; so tài liệu với server đang chạy (status code, field trong response); `--fix` đề xuất thay đổi tài liệu dưới dạng patch.

## Phát triển

```bash
npm ci
npm run check   # ESLint + kiểm kiểu + Prettier + test (Node 22 chạy thẳng test TypeScript bằng type stripping)
```

## Giấy phép

[MIT](LICENSE) © Van Nguyen
