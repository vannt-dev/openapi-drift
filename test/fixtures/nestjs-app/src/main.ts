import { NestFactory } from '@nestjs/core';
import { RequestMethod, VersioningType } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const globalPrefix = 'api';
  // app.setGlobalPrefix('old-prefix');
  app.setGlobalPrefix(globalPrefix, {
    exclude: ['health', { path: 'metrics', method: RequestMethod.GET }],
  });
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1',
  });
  await app.listen(3000);
}
void bootstrap();
