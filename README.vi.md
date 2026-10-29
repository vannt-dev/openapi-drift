# openapi-drift

[![npm](https://img.shields.io/npm/v/openapi-drift)](https://www.npmjs.com/package/openapi-drift)
[![CI](https://github.com/vannt-dev/openapi-drift/actions/workflows/ci.yml/badge.svg)](https://github.com/vannt-dev/openapi-drift/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

English: [README.md](README.md)

Đối chiếu tài liệu OpenAPI với mã nguồn, không cần chạy API. `openapi-drift` đọc các route mà code **NestJS**, **Express**, **Fastify** hoặc **Spring** của bạn khai báo, ngay từ file nguồn, so với tài liệu, và báo độ lệch theo cả hai chiều:

- route code đang phục vụ mà tài liệu không mô tả,
- operation tài liệu mô tả mà không route nào phục vụ,
- và, ở mức ghi chú: tham số đường dẫn đặt tên khác nhau (`{id}` trong tài liệu, `:orderId` trong code), query parameter mà handler đọc nhưng tài liệu không mô tả (hoặc ngược lại), và mã trạng thái code trả về mà tài liệu không mô tả.

Mọi thứ dựng trên tài liệu (test sinh tự động, SDK client, mock, người review) chỉ đúng khi tài liệu đúng. Chạy trong CI, hoặc dùng GitHub Action trên pull request, thì một pull request không thể đổi API mà không đổi tài liệu.

Đừng nhầm với Drift của SmartBear (Swagger Contract Testing): Drift gửi request tới API rồi kiểm tra response theo tài liệu, còn `openapi-drift` không bao giờ gọi API mà đọc route từ code.

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
openapi-drift check --spec openapi.yaml --source src --format sarif --output drift.sarif   # cho code scanning
openapi-drift routes --source src                                # chỉ liệt kê route code khai báo
openapi-drift lint --spec openapi.yaml                           # lỗi của chính tài liệu
openapi-drift check --spec openapi.yaml --source src --ignore /health --ignore 'GET /internal/**'
openapi-drift check --spec openapi.yaml --source src --baseline openapi-drift.json   # chỉ fail khi có lệch mới
```

| Tuỳ chọn               | Ý nghĩa                                                                                                                                                                                                                                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--spec <file>`        | Tài liệu OpenAPI 3, YAML hoặc JSON.                                                                                                                                                                                                                                                                       |
| `--source <dir>`       | Thư mục nguồn backend (mặc định `.`). Bỏ qua `node_modules`, `dist`, `build`, file test và `.d.ts`.                                                                                                                                                                                                       |
| `--framework`          | `nestjs`, `express`, `fastify`, `spring` hoặc `auto` (mặc định): NestJS khi có file `.ts` khai báo `@Controller`, Fastify hoặc Express khi có file nguồn import nó, Spring khi có file Java hoặc Kotlin chứa controller.                                                                                  |
| `--prefix <path>`      | Tiền tố code thêm vào mọi route mà nguồn không hiện ra: mount Express dựng động, tiền tố NestJS lấy từ cấu hình. Ngoài trường hợp đó NestJS không cần (xem bên dưới). Khi truyền, nó thay cho những gì đọc từ code; `/` nghĩa là không có tiền tố. Base path của tài liệu (`servers[0].url`) được tự đọc. |
| `--format`             | `text` (mặc định), `markdown`, `json`, `sarif` (log SARIF 2.1.0 cho code scanning) hoặc `github` (workflow command gắn chú thích lên dòng code trên GitHub); xem [SARIF và annotation](#sarif-và-annotation).                                                                                             |
| `--output <file>`      | Ghi thêm báo cáo ra file.                                                                                                                                                                                                                                                                                 |
| `--fail-on`            | `any` (mặc định): lệch chiều nào cũng fail; `spec`: chỉ route tài liệu thiếu; `code`: chỉ operation code thiếu; `none`: chỉ báo cáo.                                                                                                                                                                      |
| `--ignore <pattern>`   | Bỏ qua lệch trên một đường dẫn: `/health`, `'GET /internal/**'`. Dùng được nhiều lần.                                                                                                                                                                                                                     |
| `--ignore-file <file>` | Đọc pattern từ file, mỗi dòng một pattern; `#` mở đầu chú thích.                                                                                                                                                                                                                                          |
| `--baseline <file>`    | Lệch đã biết và đã chấp nhận: vẫn được báo cáo nhưng không làm fail.                                                                                                                                                                                                                                      |
| `--update-baseline`    | Ghi lệch của lần chạy này vào file `--baseline` rồi thoát với mã `0`.                                                                                                                                                                                                                                     |
| `--strict`             | Query parameter và mã trạng thái khác nhau luôn được báo cáo; thêm cờ này thì chúng cũng làm lần chạy thất bại.                                                                                                                                                                                           |

Mã thoát: `0` không lệch, `1` có lệch, `2` dùng sai hoặc tài liệu có lỗi (`lint` liệt kê trước).

### Route cố ý không ghi vào tài liệu, và lệch đang có sẵn

Hai cách để lần chạy đầu trong CI không đỏ toàn bộ.

**Pattern bỏ qua** dành cho thứ vốn không định đưa vào tài liệu: health probe, metrics, route nội bộ. Một pattern là một đường dẫn, có thể đứng sau một method; `*` thay cho một đoạn (hoặc một phần của đoạn), `**` thay cho bao nhiêu đoạn cũng được. Pattern được so với đường dẫn đúng như báo cáo in ra, gồm cả tiền tố, bỏ qua tên tham số và hoa thường, và bỏ lệch ở cả hai chiều.

```
# .openapi-drift-ignore, truyền bằng --ignore-file
/api/health            # mọi method
GET /api/internal/**   # chỉ GET, sâu bao nhiêu cũng được
/api/v*/ping
```

**Baseline** dành cho lệch đang tồn tại và sẽ sửa sau. Ghi lại một lần rồi commit file:

```bash
openapi-drift check --spec openapi.yaml --source src --baseline openapi-drift.json --update-baseline
```

Các lần chạy sau với `--baseline openapi-drift.json` liệt kê phần lệch đó dưới mục "Accepted by the baseline" và chỉ fail khi có lệch không nằm trong file. Khi một mục không còn lệch, báo cáo nêu tên nó dưới mục "No longer drifting" để bạn bỏ khỏi file (chạy lại `--update-baseline`). Pattern bỏ qua được áp dụng trước khi ghi baseline, nên file chỉ chứa phần lệch cần sửa.

### Đọc được gì

**NestJS**: `@Controller('users')`, `@Controller({ path: 'users' })`, `@Controller(['a', 'b'])`, cùng `@Get`, `@Post`, `@Put`, `@Patch`, `@Delete`, `@Head`, `@Options`, `@All` và tham số đường dẫn, trong file `.ts` và `.js`. `:id` thành `{id}`.

Những gì ứng dụng NestJS đặt cho mọi route cũng được đọc từ code, và báo cáo ghi rõ đọc ở đâu:

- global prefix, `app.setGlobalPrefix('api')`, kể cả khi lấy từ hằng trong cùng file (`const globalPrefix = 'api'`), cùng các route nó bỏ qua (`{ exclude: ['health', { path: 'metrics', method: RequestMethod.GET }] }`);
- URI versioning, `app.enableVersioning({ type: VersioningType.URI })` với `prefix` và `defaultVersion`, cùng phiên bản của `@Controller({ version: '1' })` và `@Version('2')`, gồm cả danh sách và `VERSION_NEUTRAL`. Phiên bản đặt trong header hay media type không nằm trong đường dẫn nên không đổi gì.

```
$ openapi-drift check --spec openapi.yaml --source src
openapi.yaml: 12 operations
src: 12 routes under /api
  read from the code: global prefix /api (src/main.ts:9, 2 routes left out of it); versions in the path as v<version>, 1 by default (src/main.ts:12)
```

Giá trị mà nguồn không ghi ra dạng chữ (`app.setGlobalPrefix(config.get(...))`) thì không đoán: một dòng trên stderr chỉ ra chỗ đó, và `--prefix` cho biết giá trị. Tương tự khi một cây nguồn chứa nhiều ứng dụng với thiết lập khác nhau. Khi đã truyền `--prefix` thì không đọc gì từ code nữa, nên dòng lệnh viết cho bản trước vẫn giữ nguyên nghĩa. Đường dẫn thêm bởi `RouterModule` chưa được đọc.

**Express**: `app.get('/x', ...)` và các verb khác, `router.get(...)`, `app.route('/x').get(...).post(...)`, `app.all(...)`, với router mount bằng `app.use('/prefix', router)` trong cùng file hoặc import từ file khác (`import users from './users.js'`, `const users = require('./users')`). Route có đường dẫn không phải chuỗi literal thì bỏ qua; router không được mount giữ nguyên đường dẫn của nó. Bỏ qua comment.

**Fastify**: `fastify.get('/x', ...)` và các verb khác, cùng `fastify.route({ method, url })`, mỗi route nằm dưới tiền tố của các plugin chứa nó. Plugin là thứ được truyền cho `register`: một hàm viết ngay trong lời gọi, một hàm trong cùng file, hoặc một import (`register(usersRoutes, { prefix: '/users' })`, `register(require('./users'), ...)`, `register(import('./users.js'), ...)`). Plugin đăng ký bên trong plugin mang cả hai tiền tố, và plugin không ai đăng ký thì giữ nguyên đường dẫn của nó. Fastify tự trả lời `HEAD` ở mọi nơi có `GET`: tài liệu có mô tả các operation đó là đúng, không mô tả cũng đúng. Route do `@fastify/autoload` tạo từ tên thư mục chưa được đọc.

**Spring** (Java và Kotlin): `@GetMapping("/x")`, `@PostMapping`, `@PutMapping`, `@PatchMapping`, `@DeleteMapping` và `@RequestMapping(path, method)` trên các method của `@RestController` hoặc `@Controller`, nằm dưới `@RequestMapping` của class; nhiều đường dẫn thì mỗi route xuất hiện một lần cho mỗi đường dẫn, và `{id:\\d+}` thành `{id}`. Context path được đọc từ `application.properties` hoặc `application.yml` (`server.servlet.context-path`) và báo cáo ghi rõ đọc ở đâu; thiết lập của profile và của test không tính. Mã nguồn test (`src/test`) không được đọc, và interface có cùng annotation (Feign client, interface API sinh tự động) không phải là controller. Đường dẫn để trong hằng thì không đoán: route đó bị bỏ qua và một dòng trên stderr chỉ ra chỗ đó.

Đường dẫn so sánh bỏ qua tên tham số và hoa thường, nên `/users/{id}` và `/Users/:userId` là một; tên khác nhau được báo ở mức ghi chú, không fail.

### Ngoài đường dẫn

Với một operation mà cả hai bên đều có, hai thứ nữa được so sánh, dựa trên những gì mã nguồn cho thấy về handler:

```
Query parameters that differ (1, not a failure):
  GET     /users: in the code only: sort; in the document only: limit (src/users.controller.ts:3)

Status codes that differ (1, not a failure):
  POST    /users: the code answers 201; the document describes 200, 400 (src/users.controller.ts:6)
```

- **NestJS, query parameter**: tên trong `@Query('page')` ở chữ ký của handler. Khi mọi `@Query` đều có tên thì danh sách là đầy đủ, nên tham số tài liệu mô tả mà handler không đọc cũng được báo. `@Query() dto` và `@Req()` không cho biết tên, nên không so sánh gì.
- **NestJS, mã trạng thái**: `@HttpCode(204)` hoặc `@HttpCode(HttpStatus.NO_CONTENT)`, nếu không thì là mã NestJS tự trả: 201 cho `@Post`, 200 cho phần còn lại. Handler tự cầm response (`@Res()` không có `passthrough`) hoặc redirect thì bỏ qua.
- **Express**: những gì nhìn thấy được ở handler viết tại chỗ, `req.query.page`, `req.query['page']`, `const { page } = req.query`, `res.status(201)`, `res.sendStatus(204)`. Đây chỉ là phần nhìn thấy được khi nó được viết ra dạng chữ: handler có thể đọc thêm qua hàm phụ, nên chỉ báo tham số và mã trạng thái mà tài liệu thiếu, không báo chiều ngược lại. Handler nằm ở nơi khác (`app.get('/x', listUsers)`) thì không cho biết gì.
- **Fastify**: tương tự, với `request.query.page` và `reply.code(201)`.
- **Spring, query parameter**: `@RequestParam`, theo `name`, `value` hoặc tên của tham số. Danh sách là đầy đủ khi mọi tham số của handler đều cho biết nó lấy từ đâu (`@PathVariable`, `@RequestBody`, ...); một object mà query được gán vào, một `Pageable` hay chính request thì không cho biết.
- **Spring, mã trạng thái**: `@ResponseStatus(HttpStatus.CREATED)`, nếu không thì 200. Handler trả về `ResponseEntity` tự dựng mã của nó: những mã nhìn thấy trong thân hàm (`ResponseEntity.status(HttpStatus.CREATED)`, `.ok()`, `.notFound()`, `.noContent()`) được so sánh, và chỉ báo những gì tài liệu thiếu.

Một mã trạng thái được coi là đã mô tả khi tài liệu có nó theo số, theo khoảng (`2XX`) hoặc dưới `default`. Các khác biệt này là ghi chú: mã thoát vẫn là `0` trừ khi có `--strict`. Pattern bỏ qua loại chúng ra như các phần khác; baseline không chứa chúng. `openapi-drift routes` cho thấy những gì đọc được ở mỗi handler (`?page&sort -> 200`).

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
          prefix: /api # tuỳ chọn; global prefix của NestJS được đọc từ code
          fail-on: any # hoặc spec, code, none
          ignore: | # tuỳ chọn, mỗi dòng một pattern
            /api/health
            GET /api/internal/**
          baseline: openapi-drift.json # tuỳ chọn
          strict: 'true' # tuỳ chọn: khác biệt về query và mã trạng thái làm job thất bại
```

Báo cáo Markdown vào job summary và file `openapi-drift.md` (input `report`); output `drifts` mang số lệch, để bước sau đăng thành bình luận trên pull request. Mỗi chỗ lệch còn là một annotation trên đúng dòng của nó: route trong code, hoặc operation trong tài liệu.

| Input         | Mặc định           | Ý nghĩa                                                                                                  |
| ------------- | ------------------ | -------------------------------------------------------------------------------------------------------- |
| `spec`        | (bắt buộc)         | Tài liệu OpenAPI 3, YAML hoặc JSON.                                                                      |
| `source`      | `.`                | Thư mục mã nguồn backend.                                                                                |
| `framework`   | `auto`             | `nestjs`, `express`, `fastify`, `spring` hoặc `auto`.                                                    |
| `prefix`      | `''`               | Như `--prefix`.                                                                                          |
| `fail-on`     | `any`              | `any`, `spec`, `code` hoặc `none`, như `--fail-on`.                                                      |
| `ignore`      | `''`               | Các ignore pattern, mỗi dòng một pattern.                                                                |
| `ignore-file` | `''`               | File chứa ignore pattern.                                                                                |
| `baseline`    | `''`               | File baseline; chỗ lệch có trong đó được báo cáo nhưng không làm job thất bại.                           |
| `strict`      | `'false'`          | `'true'`: query parameter và mã trạng thái khác nhau làm job thất bại.                                   |
| `report`      | `openapi-drift.md` | Nơi ghi báo cáo Markdown; báo cáo cũng được thêm vào job summary.                                        |
| `annotations` | `'true'`           | Mỗi chỗ lệch thành một error, warning hoặc notice trên dòng của nó trong pull request. `'false'` để tắt. |
| `sarif`       | `''`               | Nơi ghi log SARIF 2.1.0, cho `github/codeql-action/upload-sarif`. Để trống thì không ghi.                |

Output: `drifts` (số lệch), `report` (file Markdown) và `sarif` (file SARIF, khi có yêu cầu).

Để thấy chỗ lệch trong **Security → Code scanning** của repository, với alert mở cho tới khi sửa xong, hãy ghi log SARIF và upload. Code scanning cần quyền `security-events: write`, miễn phí cho repository public; repository private cần GitHub Code Security.

```yaml
jobs:
  drift:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      security-events: write
    steps:
      - uses: actions/checkout@v4
      - uses: vannt-dev/openapi-drift@v0
        id: drift
        with:
          spec: openapi.yaml
          source: src
          sarif: openapi-drift.sarif
      - uses: github/codeql-action/upload-sarif@v4
        if: always() && steps.drift.outputs.sarif != ''
        with:
          sarif_file: ${{ steps.drift.outputs.sarif }}
          category: openapi-drift
```

`if: always()` để vẫn upload log khi chỗ lệch làm job thất bại, cũng là lúc cần nó nhất.

### SARIF và annotation

`--format sarif` ghi mỗi phát hiện thành một result, `--format github` ghi mỗi phát hiện thành một workflow command (`::error file=src/users.ts,line=12::...`), GitHub biến nó thành annotation khi một bước workflow in ra. Phát hiện trong code trỏ tới file và dòng của route; operation mà code thiếu trỏ tới tài liệu, ở dòng của khoá `get:`/`post:`.

| Rule                  | Phát hiện                                            |
| --------------------- | ---------------------------------------------------- |
| `missing-in-spec`     | Route trong code mà tài liệu không mô tả.            |
| `missing-in-code`     | Operation trong tài liệu mà không route nào phục vụ. |
| `path-param-mismatch` | Path parameter đặt tên khác nhau.                    |
| `query-mismatch`      | Query parameter khác nhau.                           |
| `status-mismatch`     | Mã trạng thái code trả về mà tài liệu không mô tả.   |

Mức độ đi theo exit code: `error` cho thứ làm lần chạy thất bại theo `--fail-on` và `--strict`, `warning` cho lệch route mà `--fail-on` cho qua, `note` cho phần còn lại. Chỗ lệch baseline chấp nhận nằm trong log SARIF dưới dạng note bị suppress và không thành annotation; chỗ lệch bị ignore thì không có ở cả hai. GitHub hiện tối đa 10 annotation error và 10 annotation warning mỗi bước, 50 mỗi job; log SARIF và job summary chứa đầy đủ.

## Dùng như thư viện

```ts
import { loadSpec, extractRoutes, compare, markdownReport } from 'openapi-drift';

const doc = loadSpec('openapi.yaml');
// `prefix` là giá trị được truyền, hoặc giá trị đọc từ ứng dụng NestJS; `app` cho biết đọc ở đâu
const { routes, prefix, app } = extractRoutes('src', { framework: 'auto' });
const result = compare(doc, routes, { prefix });
console.log(markdownReport(result, { spec: 'openapi.yaml', source: 'src', root: process.cwd(), app }));
```

Có kèm khai báo kiểu.

## Liên quan

- [openapi-postman-test-generator](https://github.com/vannt-dev/openapi-postman-test-generator) sinh Postman collection và API test từ tài liệu mà `openapi-drift` giữ cho đúng.
- [AIWS](https://github.com/vannt-dev/aiws-factory) chạy phép so sánh này trong phase review của quy trình requirement.

## Lộ trình

So tài liệu với server đang chạy (status code, field trong response); `--fix` đề xuất thay đổi tài liệu dưới dạng patch.

## Phát triển

```bash
npm ci
npm run check   # ESLint + kiểm kiểu + Prettier + test (Node 22 chạy thẳng test TypeScript bằng type stripping)
```

## Giấy phép

[MIT](LICENSE) © Van Nguyen
