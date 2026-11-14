import os
from app.defaults import BASE_PORT, OFFSET


def port():
    env = os.environ.get('APP_ENV', 'dev')
    return int(os.environ.get('APP_PORT', BASE_PORT + OFFSET[env]))
