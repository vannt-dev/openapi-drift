import { Controller, Delete, Get, Param, Post, UseGuards, Version, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiOperation } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';

@Controller('cats')
export class CatsController {
  @Get()
  list() {
    return [];
  }

  @Version('2')
  @Get(':id')
  one(@Param('id') id: string) {
    return { id };
  }

  @Post()
  @Version(['1', '2'])
  create() {
    return {};
  }

  @Version(VERSION_NEUTRAL)
  @Get('breeds')
  breeds() {
    return [];
  }

  @UseGuards(AuthGuard('jwt'))
  @Version('3')
  @ApiOperation({ summary: 'tells @owner (by mail)' })
  @Delete(':id')
  remove(@Param('id') id: string) {
    return { id };
  }
}
